import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createCloseMock,
  createRuntimeWithExitSignal,
  createSignaledStart,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerGatewayDeferredStartupCleanupTest(): void {
  it("routes deferred startup failure through first-boot handling", async () => {
    await withIsolatedSignals(async () => {
      const { runGatewayLoop } = await import("./run-loop.js");
      const startupError = new Error("deferred startup failed");
      const startup = createDeferredCore();
      const close = createCloseMock();
      const { start, started } = createSignaledStart(close, startup.promise);
      const { runtime } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      const loop = runGatewayLoop({ start, runtime, completeBoot });
      const settled = Promise.allSettled([loop, startup.promise]);
      try {
        await Promise.race([started, loop]);
        startup.reject(startupError);

        await expect(loop).rejects.toBe(startupError);
        expect(start).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledExactlyOnceWith({ reason: "gateway startup failed" });
        expect(completeBoot).toHaveBeenCalledWith({
          outcome: "startup_failed",
          reason: startupError.message,
        });
      } finally {
        startup.reject(startupError);
        await settled;
      }
    });
  });
}

/** Exercises cleanup through the real run-loop owner and its existing suite fixture. */
export function registerGatewayLoopCleanupTests(
  acquireGatewayLock: UpdateRespawnFixtures["acquireGatewayLock"],
): void {
  it.each([
    ["an Error", new Error("startup operation failed")],
    ["undefined", undefined],
  ])("retains %s startup failure when ownership release fails", async (_label, startupError) => {
    await withIsolatedSignals(async () => {
      const { GatewayStartupCleanupError } = await import("../../gateway/server-shutdown.js");
      const { runGatewayLoop } = await import("./run-loop.js");
      const cleanupError = new Error("state ownership could not be verified");
      const release = vi.fn(async () => {
        throw cleanupError;
      });
      acquireGatewayLock.mockResolvedValueOnce({ release });
      const signals = ["SIGTERM", "SIGINT", "SIGUSR2"] as const;
      const listeners = signals.map((signal) => process.listeners(signal));
      const { runtime } = createRuntimeWithExitSignal();
      const start = vi
        .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
        .mockRejectedValue(startupError);
      const failure = await runGatewayLoop({ start, runtime }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(GatewayStartupCleanupError);
      expect(failure).toMatchObject({ cause: startupError, errors: [startupError, cleanupError] });
      expect(release).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
      expect(runtime.exit).not.toHaveBeenCalled();
      for (const [index, signal] of signals.entries()) {
        expect(process.listeners(signal)).toEqual(listeners[index]);
      }
    });
  });
}
