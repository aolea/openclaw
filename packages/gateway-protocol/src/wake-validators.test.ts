import { describe, expect, it } from "vitest";
import { validateWakeParams, validateWakeStatusParams } from "./index.js";

type ProtocolValidator = (value: unknown) => boolean;

function expectValidationCases(
  validate: ProtocolValidator,
  expected: boolean,
  values: readonly unknown[],
) {
  for (const value of values) {
    expect(validate(value)).toBe(expected);
  }
}

const expectAccepted = (validate: ProtocolValidator, values: readonly unknown[]) =>
  expectValidationCases(validate, true, values);
const expectRejected = (validate: ProtocolValidator, values: readonly unknown[]) =>
  expectValidationCases(validate, false, values);

describe("validateWakeParams", () => {
  it("accepts valid wake params", () => {
    expectAccepted(validateWakeParams, [
      { mode: "now", text: "hello" },
      { mode: "next-heartbeat", text: "remind me" },
    ]);
  });

  it("rejects missing required fields", () => {
    expectRejected(validateWakeParams, [{ mode: "now" }, { text: "hello" }, {}]);
  });

  it("accepts unknown properties for forward compatibility", () => {
    expectAccepted(validateWakeParams, [
      {
        mode: "now",
        text: "hello",
        paperclip: { version: "2026.416.0", source: "wake" },
      },
      {
        mode: "next-heartbeat",
        text: "check back",
        unknownFutureField: 42,
        anotherExtra: true,
      },
    ]);
  });

  it("accepts optional sessionKey and agentId so per-session wakes can be routed", () => {
    expectAccepted(validateWakeParams, [
      {
        mode: "now",
        text: "follow up on the report",
        sessionKey: "agent:main:telegram:8661849123:topic:4052",
        agentId: "main",
      },
      {
        mode: "next-heartbeat",
        text: "tick",
        sessionKey: "agent:main:discord:guild123:thread456",
        idempotencyKey: "mission-event-42",
      },
    ]);
  });

  it("rejects empty routing and invalid idempotency fields", () => {
    expectRejected(validateWakeParams, [
      { mode: "now", text: "x", sessionKey: "" },
      { mode: "now", text: "x", agentId: "" },
      { mode: "now", text: "x", idempotencyKey: "" },
      { mode: "now", text: "x", idempotencyKey: "x".repeat(201) },
    ]);
  });
});

describe("validateWakeStatusParams", () => {
  it("accepts exactly one durable ticket selector", () => {
    expectAccepted(validateWakeStatusParams, [
      { ticketId: "ticket-42" },
      { idempotencyKey: "mission-event-42" },
    ]);
    expectRejected(validateWakeStatusParams, [
      {},
      { ticketId: "" },
      { ticketId: 42 },
      { idempotencyKey: "" },
      { idempotencyKey: "x".repeat(201) },
      { ticketId: "ticket-42", idempotencyKey: "mission-event-42" },
    ]);
  });
});
