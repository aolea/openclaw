import fs from "node:fs";
import path from "node:path";
import type { SessionEntry } from "../config/sessions.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import { resolveSqliteDatabaseFilePaths } from "./sqlite-files.js";
import {
  ensureMigrationDir,
  fileExists,
  readSessionStoreJson5,
  safeReadDir,
  type SessionEntryLike,
} from "./state-migrations.fs.js";
import {
  aliasedSessionStoreMigrationWarning,
  canonicalizeSessionStore,
  distinctSessionStoreAliasWarning,
  emptyDirOrMissing,
  isAmbiguousSharedStoreKey,
  isLegacyDefaultMainAliasKey,
  mergeSessionEntry,
  normalizeSessionEntry,
  pickLatestLegacyDirectEntry,
  removeDirIfEmpty,
  resolveStaleLegacySessionFile,
  saveSessionStoreStrict,
  unresolvedSessionStoreIdentityWarning,
} from "./state-migrations.session-store.js";
import type { LegacyStateDetection } from "./state-migrations.types.js";

type LegacyAgentRelocation = NonNullable<LegacyStateDetection["agentDir"]["relocation"]>;

function pathEntryExists(pathname: string): boolean {
  try {
    fs.lstatSync(pathname);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return false;
    }
    if (code === "ENOTDIR") {
      return true;
    }
    throw error;
  }
}

function sourceRelocationBlocker(relocation: LegacyAgentRelocation): string | undefined {
  try {
    const source = fs.lstatSync(relocation.sourcePath);
    if (relocation.kind === "database") {
      return source.isFile()
        ? undefined
        : `Refused relocating agent database because source ${relocation.sourcePath} is no longer a regular file.`;
    }
    if (!source.isDirectory()) {
      return `Refused relocating legacy agent directory because source ${relocation.sourcePath} is no longer a directory.`;
    }
    const database = fs.lstatSync(path.join(relocation.sourcePath, "openclaw-agent.sqlite"));
    return database.isFile()
      ? undefined
      : `Refused relocating legacy agent directory because ${relocation.sourcePath} no longer contains a regular agent database.`;
  } catch (error) {
    return `Refused relocating agent database because source ${relocation.sourcePath} is unavailable: ${String(error)}.`;
  }
}

/**
 * Reject partial SQLite moves and any destination that would turn a rename
 * into a merge. The migration lock serializes OpenClaw writers, not outside
 * filesystem changes, so callers check this before dependent session moves.
 */
export function getLegacyAgentRelocationBlocker(
  relocation: LegacyAgentRelocation,
): string | undefined {
  const sourceBlocker = sourceRelocationBlocker(relocation);
  if (sourceBlocker) {
    return sourceBlocker;
  }
  if (relocation.kind === "directory") {
    // One same-filesystem directory rename keeps the primary, WAL, SHM, and
    // rollback journal together as one SQLite generation.
    return pathEntryExists(relocation.targetPath)
      ? `Refused relocating legacy agent directory because destination already exists at ${relocation.targetPath}; left source files untouched.`
      : undefined;
  }

  if (relocation.sourceHasDataSidecars) {
    return "Refused relocating misplaced agent database because SQLite sidecars are present or ambiguous; left source files untouched.";
  }
  return resolveSqliteDatabaseFilePaths(relocation.targetPath).some((pathname) =>
    pathEntryExists(pathname),
  )
    ? "Refused relocating misplaced agent database because a canonical destination or SQLite sidecar already exists; left source files untouched."
    : undefined;
}

export function clearTransientAgentDatabaseSidecars(
  relocation: LegacyAgentRelocation,
): string | undefined {
  if (relocation.kind === "directory") {
    return undefined;
  }

  const [, walPath, shmPath, journalPath] = resolveSqliteDatabaseFilePaths(relocation.sourcePath);
  for (const [pathname, containsRecoveryData] of [
    [walPath, true],
    [shmPath, false],
    [journalPath, true],
  ] as const) {
    if (!pathname) {
      continue;
    }
    try {
      const stat = fs.lstatSync(pathname);
      if (!stat.isFile() || (containsRecoveryData && stat.size > 0)) {
        return "Refused relocating misplaced agent database because SQLite sidecars appeared after detection; left source files untouched.";
      }
      fs.unlinkSync(pathname);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return `Failed clearing transient SQLite sidecar ${pathname}: ${String(error)}`;
      }
    }
  }
  return undefined;
}

function normalizeMergedSessionStore(
  merged: Record<string, SessionEntryLike>,
  protectedKeys: ReadonlySet<string>,
): {
  store: Record<string, SessionEntry>;
  rejectedProtectedKeyCount: number;
} {
  const store = Object.create(null) as Record<string, SessionEntry>;
  let rejectedProtectedKeyCount = 0;
  for (const [key, entry] of Object.entries(merged)) {
    const normalizedEntry = normalizeSessionEntry(entry, key);
    if (!normalizedEntry) {
      if (protectedKeys.has(key)) {
        rejectedProtectedKeyCount++;
      }
      continue;
    }
    store[key] = normalizedEntry;
  }
  return { store, rejectedProtectedKeyCount };
}

export async function migrateLegacySessions(
  detected: LegacyStateDetection,
  now: () => number,
  options: { recoverCorruptTargetStore?: boolean } = {},
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!detected.sessions.hasLegacy || detected.agentDir.migrationBlockedReason) {
    return { changes, warnings };
  }
  const targetAgentId = detected.targetAgentId;

  ensureMigrationDir(detected.sessions.targetDir);

  const legacyParsed = fileExists(detected.sessions.legacyStorePath)
    ? readSessionStoreJson5(detected.sessions.legacyStorePath)
    : { store: {}, ok: true };
  const targetParsed = fileExists(detected.sessions.targetStorePath)
    ? readSessionStoreJson5(detected.sessions.targetStorePath)
    : { store: {}, ok: true };
  const legacyStore = legacyParsed.store;
  const targetStore = targetParsed.store;
  if (detected.sessions.targetStoreAliases.hasUnresolvedIdentity) {
    warnings.push(
      unresolvedSessionStoreIdentityWarning(
        "legacy session migration",
        detected.sessions.targetStorePath,
      ),
    );
    return { changes, warnings };
  }
  if (detected.sessions.targetStoreAliases.hasFinalSymlink) {
    warnings.push(
      `Deferred legacy session migration in final-component symlink store ${detected.sessions.targetStorePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
    );
    return { changes, warnings };
  }

  const ambiguousAliasedKeys = new Set(
    [...Object.keys(targetStore), ...Object.keys(legacyStore)].filter(
      (key) =>
        isAmbiguousSharedStoreKey(key, detected.targetMainKey, detected.targetScope) ||
        (detected.sessions.preserveForeignMainAliases &&
          isLegacyDefaultMainAliasKey(key, detected.targetMainKey)),
    ),
  );
  // Atomic replacement separates filesystem aliases. Defer the whole merge so
  // a later startup cannot treat each pathname as a different session owner.
  if (detected.sessions.targetStoreAliases.hasDistinctAliases) {
    warnings.push(
      ambiguousAliasedKeys.size > 0
        ? aliasedSessionStoreMigrationWarning({
            subject: "migration of",
            count: ambiguousAliasedKeys.size,
            storePath: detected.sessions.targetStorePath,
          })
        : distinctSessionStoreAliasWarning(
            "legacy session migration",
            detected.sessions.targetStorePath,
          ),
    );
    return { changes, warnings };
  }

  const canonicalizedTarget = canonicalizeSessionStore({
    store: targetStore,
    agentId: targetAgentId,
    mainKey: detected.targetMainKey,
    scope: detected.targetScope,
    skipCrossAgentRemap: detected.sessions.preserveAmbiguousKeys,
    preserveCanonicalAgentOwner: true,
    preserveAmbiguousKeys: detected.sessions.preserveAmbiguousKeys,
    preserveForeignMainAliases: detected.sessions.preserveForeignMainAliases,
  });
  const canonicalizedLegacy = canonicalizeSessionStore({
    store: legacyStore,
    agentId: targetAgentId,
    mainKey: detected.targetMainKey,
    scope: detected.targetScope,
    preserveCanonicalAgentOwner: true,
    preserveForeignMainAliases: detected.sessions.preserveForeignMainAliases,
  });
  const targetKeys = new Set(Object.keys(canonicalizedTarget.store));
  const preservedLegacyForeignMainAliasCount = detected.sessions.preserveForeignMainAliases
    ? Object.keys(legacyStore).filter((key) =>
        isLegacyDefaultMainAliasKey(key, detected.targetMainKey),
      ).length
    : 0;

  let repairedStaleSessionFiles = false;
  for (const entry of Object.values(canonicalizedTarget.store)) {
    const targetSessionFile = resolveStaleLegacySessionFile({
      entry,
      legacyDir: detected.sessions.legacyDir,
      targetDir: detected.sessions.targetDir,
    });
    if (targetSessionFile) {
      entry.sessionFile = targetSessionFile;
      repairedStaleSessionFiles = true;
    }
  }

  const merged = Object.create(null) as Record<string, SessionEntryLike>;
  for (const [key, entry] of Object.entries(canonicalizedTarget.store)) {
    merged[key] = entry;
  }
  for (const [key, entry] of Object.entries(canonicalizedLegacy.store)) {
    merged[key] = mergeSessionEntry({
      existing: merged[key],
      incoming: entry,
      preferIncomingOnTie: false,
    });
  }

  const mainKey = buildAgentMainSessionKey({
    agentId: targetAgentId,
    mainKey: detected.targetMainKey,
  });
  let migratedDirectChatKey: string | undefined;
  if (!merged[mainKey]) {
    const latest = pickLatestLegacyDirectEntry(legacyStore);
    if (latest?.sessionId) {
      merged[mainKey] = latest;
      migratedDirectChatKey = mainKey;
    }
  }

  if (!legacyParsed.ok) {
    warnings.push(
      `Legacy sessions store unreadable; left in place at ${detected.sessions.legacyStorePath}`,
    );
  }

  const targetExists = fileExists(detected.sessions.targetStorePath);
  let targetReadable = !targetExists || targetParsed.ok;
  if (!targetReadable) {
    if (options.recoverCorruptTargetStore) {
      const archivedTargetPath = `${detected.sessions.targetStorePath}.corrupt-${now()}`;
      try {
        fs.renameSync(detected.sessions.targetStorePath, archivedTargetPath);
        changes.push(`Archived corrupt target sessions store → ${archivedTargetPath}`);
        targetReadable = true;
      } catch (err) {
        warnings.push(
          `Target sessions store unreadable; failed to archive ${detected.sessions.targetStorePath}: ${String(err)}`,
        );
      }
    } else {
      warnings.push(
        `Target sessions store unreadable; left untouched to avoid overwriting at ${detected.sessions.targetStorePath}. Run openclaw doctor --fix to archive it and retry the legacy merge.`,
      );
    }
  }

  if (
    targetReadable &&
    (legacyParsed.ok || targetParsed.ok) &&
    (Object.keys(legacyStore).length > 0 || Object.keys(targetStore).length > 0)
  ) {
    const normalized = normalizeMergedSessionStore(merged, targetKeys);
    if (normalized.rejectedProtectedKeyCount > 0) {
      warnings.push(
        `Refused legacy session migration because normalization rejected ${normalized.rejectedProtectedKeyCount} existing target session ${normalized.rejectedProtectedKeyCount === 1 ? "key" : "keys"}; left ${detected.sessions.targetStorePath} and ${detected.sessions.legacyStorePath} in place. Repair the conflicting rows, then rerun openclaw doctor --fix.`,
      );
      return { changes, warnings };
    }
    await saveSessionStoreStrict(detected.sessions.targetStorePath, normalized.store);
    if (migratedDirectChatKey) {
      changes.push(`Migrated latest direct-chat session → ${migratedDirectChatKey}`);
    }
    changes.push(`Merged sessions store → ${detected.sessions.targetStorePath}`);
    if (preservedLegacyForeignMainAliasCount > 0) {
      warnings.push(
        `Preserved ${preservedLegacyForeignMainAliasCount} ambiguous session key(s) while importing legacy sessions into ${detected.sessions.targetStorePath}`,
      );
    }
    if (canonicalizedTarget.legacyKeys.length > 0) {
      changes.push(`Canonicalized ${canonicalizedTarget.legacyKeys.length} legacy session key(s)`);
    }
    if (repairedStaleSessionFiles) {
      changes.push("Repaired migrated session transcript paths");
    }
  }

  if (!targetReadable) {
    return { changes, warnings };
  }

  const entries = safeReadDir(detected.sessions.legacyDir);
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name === "sessions.json") {
      continue;
    }
    const from = path.join(detected.sessions.legacyDir, entry.name);
    let to = path.join(detected.sessions.targetDir, entry.name);
    if (fileExists(to)) {
      const parsed = path.parse(entry.name);
      to = path.join(detected.sessions.targetDir, `${parsed.name}.legacy-${now()}${parsed.ext}`);
    }
    try {
      fs.renameSync(from, to);
      changes.push(`Moved ${entry.name} → agents/${targetAgentId}/sessions`);
    } catch (err) {
      warnings.push(`Failed moving ${from}: ${String(err)}`);
    }
  }

  if (legacyParsed.ok && targetReadable) {
    try {
      if (fileExists(detected.sessions.legacyStorePath)) {
        fs.rmSync(detected.sessions.legacyStorePath, { force: true });
      }
    } catch {
      // ignore
    }
  }

  removeDirIfEmpty(detected.sessions.legacyDir);
  const legacyLeft = safeReadDir(detected.sessions.legacyDir).filter((e) => e.isFile());
  if (legacyLeft.length > 0) {
    const backupDir = `${detected.sessions.legacyDir}.legacy-${now()}`;
    try {
      fs.renameSync(detected.sessions.legacyDir, backupDir);
      warnings.push(`Left legacy sessions at ${backupDir}`);
    } catch {
      // ignore
    }
  }

  return { changes, warnings };
}

export async function migrateLegacyAgentDir(
  detected: LegacyStateDetection,
  now: () => number,
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!detected.agentDir.hasLegacy) {
    return { changes, warnings };
  }
  const targetAgentId = detected.targetAgentId;
  if (detected.agentDir.migrationBlockedReason) {
    return { changes, warnings: [detected.agentDir.migrationBlockedReason] };
  }
  if (detected.agentDir.relocation) {
    const { relocation } = detected.agentDir;
    const relocationBlocker = getLegacyAgentRelocationBlocker(relocation);
    if (relocationBlocker) {
      return {
        changes,
        warnings: [relocationBlocker],
      };
    }
    const transientSidecarWarning = clearTransientAgentDatabaseSidecars(relocation);
    if (transientSidecarWarning) {
      return {
        changes,
        warnings: [transientSidecarWarning],
      };
    }
    try {
      ensureMigrationDir(path.dirname(relocation.targetPath));
      try {
        fs.renameSync(relocation.sourcePath, relocation.targetPath);
      } catch (error) {
        warnings.push(
          `Failed relocating agent database from ${relocation.sourcePath} to ${relocation.targetPath}; the registry relocation intent remains prepared. Rerun openclaw doctor --fix: ${String(error)}`,
        );
        return { changes, warnings };
      }
      changes.push(
        relocation.kind === "directory"
          ? `Moved agent dir → agents/${targetAgentId}/agent`
          : `Relocated agent database → ${path.relative(detected.stateDir, relocation.targetPath)}`,
      );
    } catch (err) {
      warnings.push(`Failed relocating agent database: ${String(err)}`);
    }
    if (relocation.kind === "directory" || warnings.length > 0) {
      return { changes, warnings };
    }
  }

  ensureMigrationDir(detected.agentDir.targetDir);

  const entries = safeReadDir(detected.agentDir.legacyDir);
  for (const entry of entries) {
    const from = path.join(detected.agentDir.legacyDir, entry.name);
    const to = path.join(detected.agentDir.targetDir, entry.name);
    if (fs.existsSync(to)) {
      continue;
    }
    try {
      fs.renameSync(from, to);
      changes.push(`Moved agent file ${entry.name} → agents/${targetAgentId}/agent`);
    } catch (err) {
      warnings.push(`Failed moving ${from}: ${String(err)}`);
    }
  }

  removeDirIfEmpty(detected.agentDir.legacyDir);
  if (!emptyDirOrMissing(detected.agentDir.legacyDir)) {
    const backupDir = path.join(
      detected.stateDir,
      "agents",
      targetAgentId,
      `agent.legacy-${now()}`,
    );
    try {
      fs.renameSync(detected.agentDir.legacyDir, backupDir);
      warnings.push(`Left legacy agent dir at ${backupDir}`);
    } catch (err) {
      warnings.push(`Failed relocating legacy agent dir: ${String(err)}`);
    }
  }

  return { changes, warnings };
}
