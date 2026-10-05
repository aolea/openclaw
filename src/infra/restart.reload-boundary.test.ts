import { expect, it, vi } from "vitest";
import {
  isGatewayReloadGenerationAborted,
  nextGatewayReloadGeneration,
} from "../gateway/server-reload-contracts.js";
import { resetGatewayRestartStateForInProcessRestart } from "./restart.js";

const reloadRuntimeLoaded = vi.hoisted(() => vi.fn());

// Observe the heavy runtime boundary while keeping cancellation state real.
vi.mock("../gateway/server-reload-handlers.js", async () => {
  reloadRuntimeLoaded();
  return await import("../gateway/server-reload-contracts.js");
});

it("fences the retiring reload before a successor starts without loading the reload runtime", async () => {
  const retiringGeneration = nextGatewayReloadGeneration();
  expect(isGatewayReloadGenerationAborted(retiringGeneration)).toBe(false);

  resetGatewayRestartStateForInProcessRestart();
  const abortedAtReturn = isGatewayReloadGenerationAborted(retiringGeneration);
  const successorGeneration = nextGatewayReloadGeneration();
  await vi.dynamicImportSettled();

  expect.soft(abortedAtReturn).toBe(true);
  expect.soft(isGatewayReloadGenerationAborted(successorGeneration)).toBe(false);
  expect(reloadRuntimeLoaded).not.toHaveBeenCalled();
});
