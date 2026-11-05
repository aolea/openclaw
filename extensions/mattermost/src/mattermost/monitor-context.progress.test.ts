import { describe, expect, it } from "vitest";
import {
  pinMattermostProgressLabel,
  resolveMattermostProgressDeliveryPolicy,
} from "./monitor-context.js";

describe("Mattermost separate progress delivery", () => {
  it("selects typed progress posts only for the explicit progress-mode opt-in", () => {
    const separate = resolveMattermostProgressDeliveryPolicy(
      {
        accountId: "work",
        config: {
          streaming: {
            mode: "progress",
            progress: { label: "Working", finalDelivery: "separate" },
          },
        },
        streamingMode: "progress",
      } as Parameters<typeof resolveMattermostProgressDeliveryPolicy>[0],
      "channel-1",
    );
    expect(separate).toMatchObject({
      separate: true,
      postType: "custom_openclaw_progress",
      pinnedLabel: "Working",
      seed: "work:channel-1",
    });

    const ordinary = resolveMattermostProgressDeliveryPolicy(
      {
        accountId: "work",
        config: {
          streaming: {
            mode: "block",
            progress: { finalDelivery: "separate" },
          },
        },
        streamingMode: "block",
      } as Parameters<typeof resolveMattermostProgressDeliveryPolicy>[0],
      "channel-1",
    );
    expect(ordinary).toMatchObject({
      separate: false,
      postType: undefined,
      pinnedLabel: undefined,
    });
  });

  it("pins the progress label once across full compositor updates", () => {
    expect(pinMattermostProgressLabel("Inspecting repository", "Working")).toBe(
      "Working\n\nInspecting repository",
    );
    expect(pinMattermostProgressLabel("Working\n\nInspecting repository", "Working")).toBe(
      "Working\n\nInspecting repository",
    );
  });
});
