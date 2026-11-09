import type { RunEmbeddedAgentInternalParams } from "./embedded-agent-runner/run/internal-params.js";

/** One admitted inference account retained through retries and turn settlement. */
export type RunInference = {
  runParams: Pick<
    RunEmbeddedAgentInternalParams,
    | "authProfileId"
    | "authProfileBinding"
    | "allowAuthProfileFallback"
    | "onSuccessfulAuthProfile"
    | "authProfileIdSource"
  >;
  assertCandidate: (provider: string, cliExecution: boolean) => void;
  dispose: () => void;
};
