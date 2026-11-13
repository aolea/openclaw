import { describe, expect, it } from "vitest";
import type { MsgContext } from "../templating.js";
import {
  resolveReactionToolFinalByDefault,
  resolveSourceReplyExpectation,
} from "./source-reply-delivery-mode.js";

const ctx: MsgContext = {
  ChatType: "channel",
  Provider: "slack",
  WasMentioned: true,
  MentionSource: "implicit_thread",
};

describe("implicit thread reply expectation", () => {
  it.each([
    { policy: "allow", overrides: {}, expected: "optional" },
    { policy: "disallow", overrides: {}, expected: "required" },
    { policy: undefined, overrides: {}, expected: "required" },
    { policy: "allow", overrides: { MentionSource: "explicit_bot" }, expected: "required" },
    { policy: "allow", overrides: { MentionSource: undefined }, expected: "required" },
    { policy: "allow", overrides: { CommandSource: "native" }, expected: "required" },
    { policy: "allow", overrides: { ChatType: "direct" }, expected: "required" },
  ] as const)(
    "selects $expected for $policy with $overrides",
    ({ policy, overrides, expected }) => {
      expect(
        resolveSourceReplyExpectation({
          ctx: { ...ctx, ...overrides },
          cfg: { surfaces: { slack: { silentReply: { group: policy } } } },
        }),
      ).toBe(expected);
    },
  );
});

describe("reaction reply completion policy", () => {
  const groupCtx: MsgContext = {
    ChatType: "channel",
    Provider: "mattermost",
    WasMentioned: true,
  };

  it.each([
    { name: "configured group turn", overrides: {}, expected: true },
    { name: "direct turn", overrides: { ChatType: "direct" }, expected: false },
    { name: "authorized command", overrides: { CommandSource: "native" }, expected: false },
    { name: "ambient room event", overrides: { InboundEventKind: "room_event" }, expected: false },
  ] as const)("returns $expected for $name", ({ overrides, expected }) => {
    expect(
      resolveReactionToolFinalByDefault({
        ctx: { ...groupCtx, ...overrides },
        cfg: {
          surfaces: {
            mattermost: { replyCompletion: { group: "message-or-reaction" } },
          },
        },
      }),
    ).toBe(expected);
  });

  it("keeps reactions nonterminal when the policy is absent or overridden", () => {
    expect(resolveReactionToolFinalByDefault({ ctx: groupCtx, cfg: {} })).toBe(false);
    expect(
      resolveReactionToolFinalByDefault({
        ctx: groupCtx,
        cfg: {
          agents: { defaults: { replyCompletion: { group: "message-or-reaction" } } },
          surfaces: { mattermost: { replyCompletion: { group: "message" } } },
        },
      }),
    ).toBe(false);
  });
});
