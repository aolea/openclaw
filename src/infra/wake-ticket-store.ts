import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import type { HeartbeatRunResult } from "./heartbeat-wake-contracts.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const PRUNE_BATCH_SIZE = 1_024;

type WakeTicketDatabase = Pick<DB, "wake_tickets">;
type WakeTicketRow = Selectable<WakeTicketDatabase["wake_tickets"]>;
type WakeTicketStatus = "queued" | "started" | "completed" | "failed" | "skipped";

type WakeTicketViewStatus = WakeTicketStatus | "unknown";

export type WakeTicketView = {
  ticketId: string;
  agentId: string;
  sessionKey: string;
  status: WakeTicketViewStatus;
  runId?: string;
  reasonCode?: string;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
};

export type WakeTicketReservation = {
  created: boolean;
  ticket: WakeTicketView;
};

const schemaStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS wake_tickets (");
const schemaEndMarker = "ON wake_tickets(finished_at_ms, created_at_ms, ticket_id);";
const schemaEnd = OPENCLAW_STATE_SCHEMA_SQL.indexOf(schemaEndMarker, schemaStart);
if (schemaStart < 0 || schemaEnd < 0) {
  throw new Error("Wake ticket schema markers are missing");
}
const schema = OPENCLAW_STATE_SCHEMA_SQL.slice(schemaStart, schemaEnd + schemaEndMarker.length);
const readyDatabases = new WeakSet<DatabaseSync>();

function requireBoundedString(value: string, label: string, maxLength = 512): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\r\n]/u.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function normalizeTerminalReasonCode(
  result: Exclude<HeartbeatRunResult, { status: "ran" }>,
): string {
  const reason = result.reason.trim();
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(reason)) {
    return reason;
  }
  return result.status === "failed" ? "heartbeat_failed" : "heartbeat_skipped";
}

function decodeWakeTicketStatus(status: string): WakeTicketStatus {
  switch (status) {
    case "queued":
    case "started":
    case "completed":
    case "failed":
    case "skipped":
      return status;
    default:
      throw new Error("wake ticket has an invalid stored status");
  }
}

function decodeWakeTicket(row: WakeTicketRow, currentProcessInstanceId: string): WakeTicketView {
  const staleNonterminal =
    (row.status === "queued" || row.status === "started") &&
    row.owner_process_instance_id !== currentProcessInstanceId;
  return {
    ticketId: row.ticket_id,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    status: staleNonterminal ? "unknown" : decodeWakeTicketStatus(row.status),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(staleNonterminal
      ? { reasonCode: "gateway_restarted" }
      : row.reason_code
        ? { reasonCode: row.reason_code }
        : {}),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    ...(row.started_at_ms === null ? {} : { startedAtMs: row.started_at_ms }),
    ...(row.finished_at_ms === null ? {} : { finishedAtMs: row.finished_at_ms }),
  };
}

function readWakeTicketRow(db: DatabaseSync, ticketId: string): WakeTicketRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<WakeTicketDatabase>(db)
      .selectFrom("wake_tickets")
      .selectAll()
      .where("ticket_id", "=", ticketId),
  );
}

function readWakeTicketByIdempotencyKey(
  db: DatabaseSync,
  idempotencyKey: string,
): WakeTicketRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<WakeTicketDatabase>(db)
      .selectFrom("wake_tickets")
      .selectAll()
      .where("idempotency_key", "=", idempotencyKey),
  );
}

function writeWakeTicket<T>(
  operation: (db: DatabaseSync) => T,
  options: OpenClawStateDatabaseOptions,
): T {
  let committedDatabase: DatabaseSync | undefined;
  const result = runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (!readyDatabases.has(db)) {
        db.exec(schema); // sqlite-allow-raw -- Canonical lazy additive DDL bootstrap only.
      }
      committedDatabase = db;
      return operation(db);
    },
    options,
    { operationLabel: "wake.ticket" },
  );
  if (committedDatabase && !committedDatabase.isTransaction) {
    readyDatabases.add(committedDatabase);
  }
  return result;
}

function pruneExpiredWakeTickets(db: DatabaseSync, now: number): void {
  const expired = getNodeSqliteKysely<WakeTicketDatabase>(db)
    .selectFrom("wake_tickets")
    .select("ticket_id")
    .where("finished_at_ms", "is not", null)
    .where("finished_at_ms", "<", now - TERMINAL_RETENTION_MS)
    .orderBy("finished_at_ms", "asc")
    .orderBy("ticket_id", "asc")
    .limit(PRUNE_BATCH_SIZE);
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<WakeTicketDatabase>(db)
      .deleteFrom("wake_tickets")
      .where("ticket_id", "in", expired),
  );
}

export function reserveWakeTicket(
  input: {
    idempotencyKey: string;
    requestSha256: string;
    ownerProcessInstanceId: string;
    agentId: string;
    sessionKey: string;
  },
  options: OpenClawStateDatabaseOptions = {},
): WakeTicketReservation {
  const idempotencyKey = requireBoundedString(
    input.idempotencyKey,
    "wake idempotency key",
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  const requestSha256 = input.requestSha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(requestSha256)) {
    throw new Error("wake request digest is invalid");
  }
  const ownerProcessInstanceId = requireBoundedString(
    input.ownerProcessInstanceId,
    "wake owner process instance",
    128,
  );
  const agentId = requireBoundedString(input.agentId, "wake agent id", 128);
  const sessionKey = requireBoundedString(input.sessionKey, "wake session key", 1_024);
  const now = Date.now();
  return writeWakeTicket((db) => {
    pruneExpiredWakeTickets(db, now);
    const existing = readWakeTicketByIdempotencyKey(db, idempotencyKey);
    if (existing) {
      if (
        existing.request_sha256 !== requestSha256 ||
        existing.agent_id !== agentId ||
        existing.session_key !== sessionKey
      ) {
        throw new Error("wake idempotency key conflicts with an existing request");
      }
      return {
        created: false,
        ticket: decodeWakeTicket(existing, ownerProcessInstanceId),
      };
    }
    const row = {
      ticket_id: randomUUID(),
      idempotency_key: idempotencyKey,
      request_sha256: requestSha256,
      owner_process_instance_id: ownerProcessInstanceId,
      agent_id: agentId,
      session_key: sessionKey,
      status: "queued" as const,
      run_id: null,
      reason_code: null,
      created_at_ms: now,
      updated_at_ms: now,
      started_at_ms: null,
      finished_at_ms: null,
    };
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<WakeTicketDatabase>(db).insertInto("wake_tickets").values(row),
    );
    return {
      created: true,
      ticket: decodeWakeTicket(row, ownerProcessInstanceId),
    };
  }, options);
}

export function getWakeTicket(
  ticketId: string,
  currentProcessInstanceId: string,
  options: OpenClawStateDatabaseOptions = {},
): WakeTicketView | undefined {
  const normalizedTicketId = requireBoundedString(ticketId, "wake ticket id", 128);
  const processInstanceId = requireBoundedString(
    currentProcessInstanceId,
    "wake process instance",
    128,
  );
  return withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => {
    if (!tableExists(db, "wake_tickets")) {
      return undefined;
    }
    const row = readWakeTicketRow(db, normalizedTicketId);
    return row ? decodeWakeTicket(row, processInstanceId) : undefined;
  }, options);
}

export function getWakeTicketByIdempotencyKey(
  idempotencyKey: string,
  currentProcessInstanceId: string,
  options: OpenClawStateDatabaseOptions = {},
): WakeTicketView | undefined {
  const normalizedIdempotencyKey = requireBoundedString(
    idempotencyKey,
    "wake idempotency key",
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  const processInstanceId = requireBoundedString(
    currentProcessInstanceId,
    "wake process instance",
    128,
  );
  return withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => {
    if (!tableExists(db, "wake_tickets")) {
      return undefined;
    }
    const row = readWakeTicketByIdempotencyKey(db, normalizedIdempotencyKey);
    return row ? decodeWakeTicket(row, processInstanceId) : undefined;
  }, options);
}

export function markWakeTicketStarted(
  ticketId: string,
  ownerProcessInstanceId: string,
  runId: string,
  options: OpenClawStateDatabaseOptions = {},
): WakeTicketView {
  const normalizedTicketId = requireBoundedString(ticketId, "wake ticket id", 128);
  const owner = requireBoundedString(ownerProcessInstanceId, "wake owner process instance", 128);
  const normalizedRunId = requireBoundedString(runId, "wake run id", 128);
  return writeWakeTicket((db) => {
    const row = readWakeTicketRow(db, normalizedTicketId);
    if (!row || row.owner_process_instance_id !== owner) {
      throw new Error("wake ticket owner is unavailable");
    }
    if (row.status !== "queued") {
      if (row.status === "started" && row.run_id === normalizedRunId) {
        return decodeWakeTicket(row, owner);
      }
      throw new Error("wake ticket cannot start from its current state");
    }
    const now = Date.now();
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<WakeTicketDatabase>(db)
        .updateTable("wake_tickets")
        .set({
          status: "started",
          run_id: normalizedRunId,
          started_at_ms: now,
          updated_at_ms: now,
        })
        .where("ticket_id", "=", normalizedTicketId)
        .where("status", "=", "queued")
        .where("owner_process_instance_id", "=", owner),
    );
    const updated = readWakeTicketRow(db, normalizedTicketId);
    if (!updated) {
      throw new Error("wake ticket disappeared after start");
    }
    return decodeWakeTicket(updated, owner);
  }, options);
}

export function settleWakeTicket(
  ticketId: string,
  ownerProcessInstanceId: string,
  result: HeartbeatRunResult,
  options: OpenClawStateDatabaseOptions = {},
): WakeTicketView {
  const normalizedTicketId = requireBoundedString(ticketId, "wake ticket id", 128);
  const owner = requireBoundedString(ownerProcessInstanceId, "wake owner process instance", 128);
  return writeWakeTicket((db) => {
    const row = readWakeTicketRow(db, normalizedTicketId);
    if (!row || row.owner_process_instance_id !== owner) {
      throw new Error("wake ticket owner is unavailable");
    }
    if (row.status === "completed" || row.status === "failed" || row.status === "skipped") {
      return decodeWakeTicket(row, owner);
    }
    const now = Date.now();
    const status: WakeTicketStatus =
      result.status === "ran" ? (row.status === "started" ? "completed" : "failed") : result.status;
    const reasonCode =
      result.status === "ran"
        ? row.status === "started"
          ? null
          : "run_start_receipt_missing"
        : normalizeTerminalReasonCode(result);
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<WakeTicketDatabase>(db)
        .updateTable("wake_tickets")
        .set({
          status,
          reason_code: reasonCode,
          finished_at_ms: now,
          updated_at_ms: now,
        })
        .where("ticket_id", "=", normalizedTicketId)
        .where("status", "in", ["queued", "started"])
        .where("owner_process_instance_id", "=", owner),
    );
    const updated = readWakeTicketRow(db, normalizedTicketId);
    if (!updated) {
      throw new Error("wake ticket disappeared after settlement");
    }
    return decodeWakeTicket(updated, owner);
  }, options);
}
