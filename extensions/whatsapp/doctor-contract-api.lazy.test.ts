import { describe, expect, it, vi } from "vitest";

const detectorModuleLoads = vi.hoisted(() => vi.fn());
const detectLegacyState = vi.hoisted(() => vi.fn());

vi.mock("./src/state-migrations.js", () => {
  detectorModuleLoads();
  return { detectWhatsAppLegacyStateMigrations: detectLegacyState };
});

describe("whatsapp doctor contract cold loading", () => {
  it("loads the state detector only when state detection is requested", async () => {
    const { legacyConfigRules, normalizeCompatibilityConfig, stateMigrations } =
      await import("./doctor-contract-api.js");

    expect(legacyConfigRules.length).toBeGreaterThan(0);
    expect(normalizeCompatibilityConfig({ cfg: {} })).toEqual({ config: {}, changes: [] });
    expect(detectorModuleLoads).not.toHaveBeenCalled();
    expect(detectLegacyState).not.toHaveBeenCalled();

    detectLegacyState.mockReturnValueOnce([
      { kind: "move", label: "Legacy state", sourcePath: "/legacy", targetPath: "/canonical" },
    ]);
    const input = {
      config: {},
      env: {},
      stateDir: "/state",
      oauthDir: "/oauth",
      context: { openPluginStateKeyedStore: vi.fn() } as never,
    };
    await expect(stateMigrations[0]?.detectLegacyState(input)).resolves.toEqual({
      preview: ["- Legacy state: /legacy → /canonical"],
    });
    expect(detectorModuleLoads).toHaveBeenCalledTimes(1);
    expect(detectLegacyState).toHaveBeenCalledExactlyOnceWith({
      cfg: input.config,
      env: input.env,
      stateDir: input.stateDir,
      oauthDir: input.oauthDir,
    });
  });
});
