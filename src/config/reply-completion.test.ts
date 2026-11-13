import { describe, expect, it } from "vitest";
import { resolveReplyCompletionSettings } from "./reply-completion.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("reply completion config resolution", () => {
  it("requires a message by default for every conversation type", () => {
    expect(
      resolveReplyCompletionSettings({ conversationType: "group", surface: "mattermost" }).policy,
    ).toBe("message");
    expect(
      resolveReplyCompletionSettings({ conversationType: "direct", surface: "mattermost" }).policy,
    ).toBe("message");
    expect(resolveReplyCompletionSettings({ conversationType: "internal" }).policy).toBe("message");
  });

  it("applies configured defaults only to group conversations", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          replyCompletion: {
            group: "message-or-reaction",
          },
        },
      },
    };

    expect(
      resolveReplyCompletionSettings({ cfg, conversationType: "group", surface: "mattermost" })
        .policy,
    ).toBe("message-or-reaction");
    expect(
      resolveReplyCompletionSettings({ cfg, conversationType: "direct", surface: "mattermost" })
        .policy,
    ).toBe("message");
    expect(resolveReplyCompletionSettings({ cfg, conversationType: "internal" }).policy).toBe(
      "message",
    );
  });

  it("lets surface overrides beat the default policy", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          replyCompletion: {
            group: "message-or-reaction",
          },
        },
      },
      surfaces: {
        mattermost: {
          replyCompletion: {
            group: "message",
          },
        },
      },
    };

    expect(
      resolveReplyCompletionSettings({ cfg, conversationType: "group", surface: "mattermost" })
        .policy,
    ).toBe("message");
  });

  it("accepts only supported policy values in the public config schema", () => {
    expect(
      OpenClawSchema.safeParse({
        surfaces: {
          mattermost: { replyCompletion: { group: "message-or-reaction" } },
        },
      }).success,
    ).toBe(true);
    expect(
      OpenClawSchema.safeParse({
        agents: { defaults: { replyCompletion: { group: "reaction-only" } } },
      }).success,
    ).toBe(false);
  });
});
