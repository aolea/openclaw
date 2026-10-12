import { MessageChannel } from "node:worker_threads";
import { GatewayStartupCleanupError } from "../../gateway/server-shutdown.js";
import { installGatewayHostLifeline } from "./host-lifeline.js";

/** Owns process liveness, listener registrations and final settlement for one run loop. */
export class GatewayLoopCleanup {
  private readonly processLifetime: MessageChannel | undefined;
  private signalListeners: ReadonlyArray<readonly [NodeJS.Signals, () => void]> = [];
  private releaseHostLifeline: (() => void) | undefined;
  private releaseInstallationObserver: (() => void) | undefined;
  private loopFailure: { error: unknown } | undefined;

  constructor(ownsProcessLifecycle: boolean) {
    // Node's signal listeners and pending promises do not retain the event loop.
    this.processLifetime = ownsProcessLifecycle ? new MessageChannel() : undefined;
    this.processLifetime?.port1.ref();
  }

  installSignalListeners(handlers: {
    onSigterm: () => void;
    onSigint: () => void;
    onRestartSignal: () => void;
  }): void {
    this.signalListeners = [
      ["SIGTERM", handlers.onSigterm],
      ["SIGINT", handlers.onSigint],
      // SIGUSR1 belongs to Node's on-demand inspector.
      ["SIGUSR2", handlers.onRestartSignal],
    ];
    for (const [signal, handler] of this.signalListeners) {
      process.on(signal, handler);
    }
  }

  retainInstallationObserver(release: () => void): void {
    this.releaseInstallationObserver = release;
  }

  installHostLifeline(onClosed: () => void): void {
    this.releaseHostLifeline = installGatewayHostLifeline(onClosed);
  }

  releaseProcessResources(): void {
    this.releaseHostLifeline?.();
    this.releaseHostLifeline = undefined;
    this.releaseInstallationObserver?.();
    for (const [signal, handler] of this.signalListeners) {
      process.removeListener(signal, handler);
    }
    this.processLifetime?.port1.close();
    this.processLifetime?.port2.close();
  }

  recordFailure(error: unknown): void {
    // A wrapper preserves a thrown undefined as an initiating failure.
    this.loopFailure = { error };
  }

  async close(resources: {
    retireHost: () => void | Promise<void>;
    releaseLock: () => Promise<void>;
  }): Promise<void> {
    try {
      await resources.retireHost();
      await resources.releaseLock();
    } catch (cleanupError) {
      // An ownership release failure must not hide the initiating failure.
      if (this.loopFailure) {
        throw new GatewayStartupCleanupError(this.loopFailure.error, cleanupError);
      }
      throw cleanupError;
    } finally {
      this.releaseProcessResources();
    }
  }
}
