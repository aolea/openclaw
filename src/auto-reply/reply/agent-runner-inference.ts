import type { RunInference } from "../../agents/run-inference.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";

/** Bind the admitted personal selection, independently of the person's new-chat default. */
export async function preparePersonalRunInference(params: {
  authProfileId?: string;
  provider: string;
  model: string;
  agentId: string;
  agentDir: string;
  cfg: OpenClawConfig;
  assertCurrent: () => void;
}): Promise<RunInference | undefined> {
  const profileId = params.authProfileId;
  if (!profileId || !isUserModelAuthProfileId(profileId)) {
    return undefined;
  }
  const { captureAuthProfileAuthorization } =
    await import("../../agents/auth-profiles/authorization.js");
  const authorization = await captureAuthProfileAuthorization({
    profileId,
    agentDir: params.agentDir,
    cfg: params.cfg,
    assertCurrent: params.assertCurrent,
  });
  try {
    const { resolveSessionAuthSelection } =
      await import("../../agents/auth-profiles/session-override.js");
    const selection = await resolveSessionAuthSelection({
      cfg: params.cfg,
      agentId: params.agentId,
      agentDir: params.agentDir,
      provider: params.provider,
      modelId: params.model,
      configuredProfileId: profileId,
      isNewSession: false,
    });
    authorization.assertCurrent();
    if (selection?.profileId !== profileId || !selection.routeRequirement) {
      throw new Error("The selected personal model account has no supported inference route.");
    }
    return {
      runParams: {
        authProfileId: profileId,
        authProfileIdSource: "user",
        authProfileBinding: {
          profileId,
          authRequirement: selection.routeRequirement,
          assertCurrent: authorization.assertCurrent,
          revalidate: authorization.revalidate,
        },
        allowAuthProfileFallback: false,
        onSuccessfulAuthProfile(selectedProfileId) {
          if (selectedProfileId !== profileId) {
            throw new Error(
              "Inference used a different account from the admitted personal selection.",
            );
          }
        },
      },
      assertCandidate(provider, cliExecution) {
        authorization.assertCurrent();
        if (provider !== params.provider || cliExecution) {
          throw new Error(
            "The selected personal model account cannot use another provider or a CLI login. " +
              "Select a compatible model or account and send a new message.",
          );
        }
      },
      dispose: authorization.dispose,
    };
  } catch (error) {
    authorization.dispose();
    throw error;
  }
}

/** A retry or live model switch cannot replace the turn's admitted personal account. */
export function assertPersonalRunInferenceSelection(
  profileId: string | undefined,
  inference: RunInference | undefined,
): void {
  const boundProfileId = inference?.runParams.authProfileId;
  if (
    (isUserModelAuthProfileId(profileId ?? "") || isUserModelAuthProfileId(boundProfileId ?? "")) &&
    profileId !== boundProfileId
  ) {
    throw new Error(
      "The personal model account changed during this turn. Send a new message to use it.",
    );
  }
}
