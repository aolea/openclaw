// Exercises the complete guard decision against authenticated GitHub API responses.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  renderAuthorizedDependencyComment,
  renderBlockedDependencyComment,
  renderTrustedDependencyComment,
  runDependencyGuard,
} from "../../scripts/github/dependency-guard.mjs";

const head = "a".repeat(40);
const stale = "b".repeat(40);
const barrier = "2026-10-05T10:00:00Z";
const commandTime = "2026-10-05T10:01:00Z";
const blockedBody = renderBlockedDependencyComment({
  baseBranch: "main",
  headSha: head,
  lockfileChanges: ["pnpm-lock.yaml"],
  dependencyManifestChanges: [],
  autoscrubStatus: null,
});
const receipt = (body: string) => ({
  id: 1,
  body,
  updated_at: barrier,
  created_at: barrier,
  user: { login: "github-actions[bot]" },
});
const errorWithStatus = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

function fixture(
  options: {
    fork?: unknown;
    repositoryName?: string;
    permission?: unknown;
    permissionError?: number;
    teamState?: string;
    comments?: ReturnType<typeof receipt>[];
    eventHead?: string;
    graph?: unknown[];
    dependencyFiles?: boolean;
    mode?: "detect" | "enforce" | "autoscrub";
  } = {},
) {
  const writes: Array<{ path: string; body: string }> = [];
  const requests: string[] = [];
  const pullRequest = {
    number: 3,
    user: { login: "author" },
    head: { sha: head, ref: "feature" },
    base: {
      sha: stale,
      ref: "main",
      repo: { fork: options.fork ?? true, full_name: options.repositoryName ?? "owner/repo" },
    },
  };
  const api = {
    request: async (path: string, init?: Record<string, unknown>) => {
      requests.push(path);
      if (init?.method && init.method !== "GET") {
        writes.push({ path, body: String(init.body ?? "") });
        return {};
      }
      if (path === "/repos/owner/repo/pulls/3") return pullRequest;
      if (path.includes("/memberships/")) {
        if (options.teamState) return { state: options.teamState };
        throw errorWithStatus(404);
      }
      if (path.includes("/collaborators/")) {
        if (options.permissionError) throw errorWithStatus(options.permissionError);
        return { permission: options.permission ?? "write" };
      }
      throw new Error(`Unexpected read ${path}`);
    },
    paginate: async (path: string) => {
      requests.push(path);
      if (path.endsWith("/files"))
        return options.dependencyFiles === false ? [] : [{ filename: "pnpm-lock.yaml" }];
      if (path.endsWith("/comments")) return options.comments ?? [];
      if (path.endsWith("/labels")) return [{ name: "dependencies-changed" }];
      if (path.includes("/dependency-graph/compare/")) {
        if (options.graph) return options.graph;
        throw errorWithStatus(403);
      }
      throw new Error(`Unexpected page ${path}`);
    },
  };
  const run = () =>
    runDependencyGuard({
      api,
      repository: "owner/repo",
      event: { pull_request: { number: 3, head: { sha: options.eventHead ?? head } } },
      mode: options.mode,
    });
  return { run, requests, writes };
}

async function runQuietly(run: () => Promise<void>) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await run();
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
}

describe("fork dependency guard admission", () => {
  it.each(["detect", "enforce", "autoscrub"] as const)(
    "blocks untrusted forks without scheduling or performing auto-scrub in %s mode",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "dependency-guard-fork-"));
      const outputPath = join(directory, "outputs");
      vi.stubEnv("GITHUB_OUTPUT", outputPath);
      try {
        const f = fixture({ mode });
        await expect(runQuietly(f.run)).rejects.toThrow("verified current-head authorization");
        expect(await readFile(outputPath, "utf8")).toBe("autoscrub=false\n");
        expect(f.requests.some((p) => p.includes("/dependency-graph/compare/"))).toBe(false);
        expect(f.writes.every((w) => w.path.startsWith("/repos/owner/repo/issues/"))).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["repository admin", { permission: "admin" }],
    ["active secops member", { teamState: "active" }],
  ])(
    "admits a freshly verified %s without calling the unsupported fork API",
    async (_label, options) => {
      const f = fixture(options);
      await runQuietly(f.run);
      expect(f.requests.some((p) => p.includes("/dependency-graph/compare/"))).toBe(false);
      expect(f.writes.some((w) => w.body.includes("Dependency graph changes noted"))).toBe(true);
      expect(f.requests.some((p) => p.includes("/memberships/") || p.includes("/permission"))).toBe(
        true,
      );
    },
  );

  it.each([
    ["write permission", { permission: "write" }],
    ["revoked permission", { permission: "none" }],
    ["ambiguous permission", { permission: true }],
    ["missing permission", { permission: {} }],
    ["forbidden permission lookup", { permissionError: 403 }],
    ["missing collaborator", { permissionError: 404 }],
    ["permission service error", { permissionError: 500 }],
    ["pending membership", { teamState: "pending" }],
    ["stale event", { permission: "admin", eventHead: stale }],
  ])(
    "blocks %s without interpreting unavailable graph data as approval",
    async (_label, options) => {
      const f = fixture(options);
      await expect(runQuietly(f.run)).rejects.toThrow("verified current-head authorization");
      expect(f.requests.some((p) => p.includes("/dependency-graph/compare/"))).toBe(false);
      expect(f.writes.some((w) => w.body.includes("Dependency graph changes are blocked"))).toBe(
        true,
      );
      expect(f.writes.every((w) => !w.path.includes("/git/"))).toBe(true);
    },
  );

  it("does not preserve a trusted-author receipt after revocation", async () => {
    const f = fixture({
      comments: [
        receipt(
          renderTrustedDependencyComment({
            actor: { login: "author", reason: "repository admin" },
            headSha: head,
          }),
        ),
      ],
    });
    await expect(runQuietly(f.run)).rejects.toThrow("verified current-head authorization");
  });

  it.each(["admin", "write"])(
    "rechecks cached exact-head approver role (%s)",
    async (permission) => {
      const f = fixture({
        permission,
        eventHead: stale,
        comments: [receipt(renderAuthorizedDependencyComment({ login: "reviewer", sha: head }))],
      });
      if (permission === "admin") await runQuietly(f.run);
      else await expect(runQuietly(f.run)).rejects.toThrow("verified current-head authorization");
      expect(f.requests).toContain("/repos/owner/repo/collaborators/reviewer/permission");
    },
  );

  it.each([
    ["stale receipt", renderAuthorizedDependencyComment({ login: "reviewer", sha: stale })],
    [
      "ambiguous receipt",
      renderAuthorizedDependencyComment({ login: "reviewer", sha: head }) +
        "\n- Approved by: @other",
    ],
    [
      "missing approver",
      renderAuthorizedDependencyComment({ login: "reviewer", sha: head }).replace(
        "- Approved by: @reviewer",
        "",
      ),
    ],
  ])("rejects %s", async (_label, body) => {
    const f = fixture({ permission: "admin", eventHead: stale, comments: [receipt(body)] });
    await expect(runQuietly(f.run)).rejects.toThrow("verified current-head authorization");
  });

  it("accepts only a current-role override after a bot barrier for the same head", async () => {
    const command = {
      id: 2,
      body: "/allow-dependencies-change reviewed",
      created_at: commandTime,
      updated_at: commandTime,
      user: { login: "reviewer" },
    };
    for (const [permission, barrierBody, accepted] of [
      ["admin", blockedBody, true],
      ["write", blockedBody, false],
      ["admin", blockedBody.replaceAll(head, stale), false],
    ] as const) {
      const f = fixture({
        permission,
        eventHead: stale,
        comments: [receipt(barrierBody), command],
      });
      if (accepted) await runQuietly(f.run);
      else await expect(runQuietly(f.run)).rejects.toThrow("verified current-head authorization");
    }
  });

  it("does not trust spoofed bot or event repository claims", async () => {
    const spoof = receipt(renderAuthorizedDependencyComment({ login: "reviewer", sha: head }));
    spoof.user.login = "untrusted";
    await expect(runQuietly(fixture({ comments: [spoof] }).run)).rejects.toThrow(
      "verified current-head authorization",
    );
    const f = fixture({ fork: false, permission: "admin" });
    await expect(runQuietly(f.run)).rejects.toThrow("HTTP 403");
    expect(f.requests.some((p) => p.includes("/dependency-graph/compare/"))).toBe(true);
  });

  it("preserves non-fork removal-only exemption and rejects API failures", async () => {
    const f = fixture({ fork: false, graph: [{ change_type: "removed", name: "old" }] });
    await runQuietly(f.run);
    expect(f.writes.some((w) => w.body.includes("Dependency removals noted"))).toBe(true);
    for (const options of [{ fork: false }, { fork: "true" }, { repositoryName: "other/repo" }]) {
      await expect(runQuietly(fixture({ ...options, permission: "admin" }).run)).rejects.toThrow(
        "HTTP 403",
      );
    }
  });

  it("keeps dependency-free bootstrap PRs independent of the graph endpoint", async () => {
    const f = fixture({ dependencyFiles: false });
    await runQuietly(f.run);
    expect(
      f.requests.some((p) => p.includes("/dependency-graph/compare/") || p.includes("/permission")),
    ).toBe(false);
  });
});
