// Tests heartbeat reason formatting and normalization.
import { describe, expect, it } from "vitest";
import { normalizeHeartbeatWakeReason, resolveHeartbeatWakePriority } from "./heartbeat-reason.js";

describe("heartbeat-reason", () => {
  it.each([
    { value: "  cron:job-1  ", expected: "cron:job-1" },
    { value: "  ", expected: "requested" },
    { value: undefined, expected: "requested" },
  ])("normalizes wake reasons for %j", ({ value, expected }) => {
    expect(normalizeHeartbeatWakeReason(value)).toBe(expected);
  });

  it.each([
    { source: "retry", intent: "event", reason: "retry", expected: 0 },
    { source: "interval", intent: "scheduled", reason: "interval", expected: 1 },
    { source: "exec-event", intent: "event", reason: "wake", expected: 2 },
    { source: "other", intent: "event", reason: undefined, expected: 2 },
    { source: "manual", intent: "manual", reason: "wake", expected: 3 },
  ] as const)("orders $intent/$source wakes at priority $expected", (wake) => {
    expect(resolveHeartbeatWakePriority(wake)).toBe(wake.expected);
  });
});
