import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  getWakeTicket,
  getWakeTicketByIdempotencyKey,
  markWakeTicketStarted,
  reserveWakeTicket,
  settleWakeTicket,
} from "./wake-ticket-store.js";

const tempDirs = createTempDirTracker();

function isolatedOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-wake-ticket-") } };
}

function requestDigest(text = "continue mission") {
  return createHash("sha256").update(text).digest("hex");
}

function reserve(options: ReturnType<typeof isolatedOptions>, overrides = {}) {
  return reserveWakeTicket(
    {
      idempotencyKey: "mission-event-1",
      requestSha256: requestDigest(),
      ownerProcessInstanceId: "gateway-1",
      agentId: "emon",
      sessionKey: "agent:emon:mattermost:thread:mission-1",
      ...overrides,
    },
    options,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("wake ticket store", () => {
  it("keeps a cold status read non-creating", () => {
    const options = isolatedOptions();
    const filename = resolveOpenClawStateSqlitePath(options.env);

    expect(getWakeTicket("missing-ticket", "gateway-1", options)).toBeUndefined();
    expect(
      getWakeTicketByIdempotencyKey("missing-idempotency-key", "gateway-1", options),
    ).toBeUndefined();
    expect(fs.existsSync(filename)).toBe(false);
  });

  it("reserves once and replays the same ticket for an identical request", () => {
    const options = isolatedOptions();
    const first = reserve(options);
    const replay = reserve(options);

    expect(first).toMatchObject({ created: true, ticket: { status: "queued" } });
    expect(replay).toEqual({ created: false, ticket: first.ticket });
    expect(getWakeTicketByIdempotencyKey("mission-event-1", "gateway-1", options)).toEqual(
      first.ticket,
    );
    expect(() => reserve(options, { requestSha256: requestDigest("different request") })).toThrow(
      "wake idempotency key conflicts",
    );
  });

  it("records the exact run start before allowing successful completion", () => {
    const options = isolatedOptions();
    const created = reserve(options).ticket;

    const started = markWakeTicketStarted(created.ticketId, "gateway-1", "run-42", options);
    expect(started).toMatchObject({ status: "started", runId: "run-42" });

    const completed = settleWakeTicket(
      created.ticketId,
      "gateway-1",
      { status: "ran", durationMs: 7 },
      options,
    );
    expect(completed).toMatchObject({ status: "completed", runId: "run-42" });
    expect(completed.finishedAtMs).toEqual(expect.any(Number));
  });

  it("fails closed when a run reports success without a start receipt", () => {
    const options = isolatedOptions();
    const created = reserve(options).ticket;

    expect(
      settleWakeTicket(created.ticketId, "gateway-1", { status: "ran", durationMs: 1 }, options),
    ).toMatchObject({
      status: "failed",
      reasonCode: "run_start_receipt_missing",
    });
  });

  it("projects nonterminal tickets as unknown after a gateway restart", () => {
    const options = isolatedOptions();
    const queued = reserve(options).ticket;

    expect(getWakeTicket(queued.ticketId, "gateway-2", options)).toMatchObject({
      status: "unknown",
      reasonCode: "gateway_restarted",
    });
    expect(() =>
      markWakeTicketStarted(queued.ticketId, "gateway-2", "run-foreign", options),
    ).toThrow("wake ticket owner is unavailable");
  });

  it("retains the first terminal fact and stores only bounded reason codes", () => {
    const options = isolatedOptions();
    const created = reserve(options).ticket;
    const failed = settleWakeTicket(
      created.ticketId,
      "gateway-1",
      { status: "failed", reason: "Provider failure\nwith unbounded detail" },
      options,
    );

    expect(failed).toMatchObject({ status: "failed", reasonCode: "heartbeat_failed" });
    expect(
      settleWakeTicket(
        created.ticketId,
        "gateway-1",
        { status: "skipped", reason: "disabled" },
        options,
      ),
    ).toEqual(failed);
    expect(getWakeTicket(created.ticketId, "gateway-2", options)).toEqual(failed);
  });
});
