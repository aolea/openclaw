import { describe, expect, it } from "vitest";
import { useBundledProviderPolicyArtifactsForTest } from "../../plugin-sdk/test-helpers/provider-policy-artifacts.test-support.js";
import { clearUserProfileAuthLinkAsync } from "../../state/user-model-account-operations.js";
import { connectUserModelAccount } from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  assertPersonalRunInferenceSelection,
  preparePersonalRunInference,
} from "./agent-runner-inference.js";

useBundledProviderPolicyArtifactsForTest(["openai"]);

describe("personal reply inference authority", () => {
  it("retains the selected account across default removal and rejects replacement candidates", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const person = ensureProfileForEmail("personal-run@example.test");
      const { authProfileId } = connectUserModelAccount({
        ownerProfileId: person.id,
        credential: { type: "api_key", provider: "openai", key: "synthetic-personal-key" },
        assertCurrent() {},
      });
      const inference = await preparePersonalRunInference({
        authProfileId,
        provider: "openai",
        model: "synthetic-model",
        agentId: "main",
        agentDir: state.agentDir(),
        cfg: { plugins: { enabled: false } },
        assertCurrent() {},
      });
      expect(inference).toBeDefined();
      try {
        expect(inference!.runParams).toMatchObject({
          authProfileId,
          authProfileIdSource: "user",
          allowAuthProfileFallback: false,
          authProfileBinding: { profileId: authProfileId, authRequirement: "api-key" },
        });
        await clearUserProfileAuthLinkAsync({
          profileId: person.id,
          provider: "openai",
          assertCurrent() {},
        });
        await inference!.runParams.authProfileBinding!.revalidate();
        expect(() => inference!.assertCandidate("openai", false)).not.toThrow();
        expect(() => inference!.assertCandidate("backup", false)).toThrow("another provider");
        expect(() => inference!.assertCandidate("openai", true)).toThrow("CLI login");
        expect(() => inference!.runParams.onSuccessfulAuthProfile?.("openai:shared")).toThrow(
          "different account",
        );
        expect(() => assertPersonalRunInferenceSelection(authProfileId, inference)).not.toThrow();
        expect(() => assertPersonalRunInferenceSelection("openai:shared", inference)).toThrow(
          "changed during this turn",
        );
        expect(() => assertPersonalRunInferenceSelection(authProfileId, undefined)).toThrow(
          "changed during this turn",
        );
      } finally {
        inference?.dispose();
      }
      expect(() => inference!.runParams.authProfileBinding!.assertCurrent()).toThrow();
    });
  });

  it("rejects an unavailable personal owner instead of preparing shared inference", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const person = ensureProfileForEmail("missing-personal-run@example.test");
      await expect(
        preparePersonalRunInference({
          authProfileId: `personal:${person.id}:11111111-1111-1111-1111-111111111111`,
          provider: "openai",
          model: "synthetic-model",
          agentId: "main",
          agentDir: state.agentDir(),
          cfg: { plugins: { enabled: false } },
          assertCurrent() {},
        }),
      ).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_RETIRED" });
    });
  });

  it("leaves shared and absent account selections on their existing path", async () => {
    for (const authProfileId of [undefined, "openai:shared"]) {
      expect(
        await preparePersonalRunInference({
          authProfileId,
          provider: "openai",
          model: "synthetic-model",
          agentId: "main",
          agentDir: "/unused",
          cfg: {},
          assertCurrent() {
            throw new Error("Shared selection must not acquire personal authority");
          },
        }),
      ).toBeUndefined();
      expect(() => assertPersonalRunInferenceSelection(authProfileId, undefined)).not.toThrow();
    }
  });
});
