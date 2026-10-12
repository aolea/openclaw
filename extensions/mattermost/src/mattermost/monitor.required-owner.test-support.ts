import fs from "node:fs/promises";
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } from "openclaw/plugin-sdk/channel-outbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createRuntimeEnv as testRuntime } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, it, vi, type Mock } from "vitest";
import type { createMattermostInboundRuntimeCoreFactory } from "./monitor.inbound-runtime.test-support.js";
import type { OpenClawConfig, RuntimeEnv } from "./runtime-api.js";

type MattermostMonitorSocket = {
  readonly openListenerCount: number;
  emitOpen: () => void;
  emitClose: (code: number, reason?: string) => void;
};

type MattermostIngressTestHarness<TSocket extends MattermostMonitorSocket> = {
  testConfig: OpenClawConfig;
  createRuntimeCore: ReturnType<typeof createMattermostInboundRuntimeCoreFactory>;
  FakeWebSocket: new () => TSocket;
  openMonitor: (
    socket: TSocket,
    abortController: AbortController,
    config?: OpenClawConfig,
    runtime?: RuntimeEnv,
  ) => Promise<{ monitor: Promise<void> }>;
  startTestMonitor: (
    config: OpenClawConfig,
    abortController: AbortController,
    socket: TSocket,
  ) => Promise<void>;
  emitMattermostChannelPost: (
    socket: TSocket,
    post: {
      id: string;
      message: string;
      rootId?: string;
      senderId?: string;
      type?: string;
      postChannelId?: string;
      updateAt?: number;
    },
  ) => Promise<void>;
  tempDirs: { make: (prefix: string) => string };
  mockState: {
    ingressQueue: unknown;
    runtimeCore: unknown;
    dispatchInboundMessage: Mock;
    dispatchRequiredConversationIngress: Mock;
    sendMessageMattermost: Mock;
  };
};

export function registerMattermostRequiredOwnerAdmissionTests<
  TSocket extends MattermostMonitorSocket,
>(harness: MattermostIngressTestHarness<TSocket>) {
  const { testConfig, FakeWebSocket, openMonitor, emitMattermostChannelPost, mockState } = harness;
  it("required owner captures native posts before system-type, self, mention, command and debounce activation", async () => {
    mockState.dispatchRequiredConversationIngress.mockResolvedValue({
      status: "accepted",
      bindingId: "required-1",
    });
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    const { monitor } = await openMonitor(socket, abortController);
    try {
      await emitMattermostChannelPost(socket, {
        id: "context-1",
        message: "unaddressed progress",
        rootId: "task-root",
        senderId: "bot-user",
        type: "custom_openclaw_progress",
      });
      await emitMattermostChannelPost(socket, {
        id: "action-1",
        message: "@openclaw /new",
        postChannelId: "   ",
        updateAt: 1_714_000_000_200,
        rootId: "task-root",
      });
      expect(mockState.dispatchRequiredConversationIngress).toHaveBeenCalledTimes(2);
      expect(mockState.dispatchRequiredConversationIngress.mock.calls[0]?.[0]).toMatchObject({
        scope: {
          channel: "mattermost",
          accountId: "default",
          conversationId: "chan-1",
          threadId: "task-root",
        },
        event: {
          messageId: "context-1",
          senderId: "bot-user",
          wasMentioned: false,
          metadata: {
            self: true,
            nativeBotUserId: "bot-user",
            postType: "custom_openclaw_progress",
          },
        },
      });
      expect(mockState.dispatchRequiredConversationIngress.mock.calls[1]?.[0]).toMatchObject({
        scope: { conversationId: "chan-1", threadId: "task-root" },
        event: {
          messageId: "action-1",
          wasMentioned: true,
          metadata: { nativeChannelId: "chan-1", updateAt: 1_714_000_000_200 },
        },
      });
      expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
      expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
    } finally {
      abortController.abort();
      socket.emitClose(1000);
      await monitor;
    }
  });

  it("required owner failure does not fall back to ordinary Mattermost dispatch", async () => {
    mockState.dispatchRequiredConversationIngress.mockResolvedValue({
      status: "blocked",
      bindingId: "required-1",
      reason: "owner_unavailable",
    });
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    const runtime = { ...testRuntime(), error: vi.fn() };
    const { monitor } = await openMonitor(socket, abortController, testConfig, runtime);
    try {
      await emitMattermostChannelPost(socket, {
        id: "protected-1",
        message: "@openclaw do work",
        rootId: "task-root",
      });
      expect(mockState.dispatchRequiredConversationIngress).toHaveBeenCalledOnce();
      expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
      expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
    } finally {
      abortController.abort();
      socket.emitClose(1000);
      await monitor;
    }
  });
}

export function registerMattermostIngressRetryTests<TSocket extends MattermostMonitorSocket>(
  harness: MattermostIngressTestHarness<TSocket>,
) {
  const {
    testConfig,
    createRuntimeCore,
    FakeWebSocket,
    startTestMonitor,
    emitMattermostChannelPost,
    tempDirs,
    mockState,
  } = harness;
  it.each([false, true])(
    "preserves retry accounting, backoff and restart with required owner=%s",
    async (requiredOwner) => {
      vi.useFakeTimers();
      const now = Date.UTC(2026, 0, 2);
      vi.setSystemTime(now);
      const stateDir = await fs.realpath(tempDirs.make("openclaw-mattermost-abandon-"));
      type Payload = { version: 1; receivedAt: number; rawEvent: string };
      const queue = createChannelIngressQueueForTests<Payload>({
        channelId: "mattermost",
        accountId: "default",
        stateDir,
      });
      mockState.ingressQueue = queue;
      mockState.runtimeCore = createRuntimeCore(testConfig, undefined, {
        inboundDebounceMs: 0,
        createInboundDebouncer,
      });
      mockState.dispatchInboundMessage.mockRejectedValue(
        new Error("Mattermost dispatch failed before adoption"),
      );
      let restoreRequiredOwner: (() => Promise<void>) | undefined;
      let closeRequiredOwner: (() => Promise<void>) | undefined;
      const nativeClaim = vi.fn(async () => ({ handled: true, disposition: "accepted" as const }));
      if (requiredOwner) {
        const host = await import("openclaw/plugin-sdk/plugin-test-runtime");
        const native = await vi.importActual<
          typeof import("openclaw/plugin-sdk/conversation-binding-runtime")
        >("openclaw/plugin-sdk/conversation-binding-runtime");
        const previousRegistry = host.getActivePluginRegistry();
        const previousStateDir = process.env.OPENCLAW_STATE_DIR;
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        process.env.OPENCLAW_STATE_DIR = stateDir;
        const registerOwner = async () => {
          const builder = host.createPluginRegistry({
            logger: { info() {}, warn() {}, error() {} },
            runtime: createPluginRuntimeMock(),
          });
          const record = host.createPluginRecord({ id: "required-native-owner", source: "test" });
          const api = builder.createApi(record, { config: testConfig });
          api.on("inbound_claim", nativeClaim);
          builder.registry.plugins.push(record);
          host.setActivePluginRegistry(builder.registry);
          host.initializeGlobalHookRunner(builder.registry);
          await api.conversationRoutes.protect({
            channel: "mattermost",
            accountId: "default",
            conversationId: "chan-1",
          });
        };
        closeRequiredOwner = async () => {
          host.setActivePluginRegistry(previousRegistry ?? host.createEmptyPluginRegistry());
          host.resetGlobalHookRunner();
          await closeOpenClawStateDatabaseAsync();
          closeOpenClawStateDatabaseForTest();
          if (previousStateDir === undefined) {
            delete process.env.OPENCLAW_STATE_DIR;
          } else {
            process.env.OPENCLAW_STATE_DIR = previousStateDir;
          }
        };
        try {
          await registerOwner();
          const missingOwner = host.createEmptyPluginRegistry();
          host.setActivePluginRegistry(missingOwner);
          host.initializeGlobalHookRunner(missingOwner);
          // The route survives a host state reopen and the registered plugin's absence.
          await closeOpenClawStateDatabaseAsync();
          closeOpenClawStateDatabaseForTest();
          mockState.dispatchRequiredConversationIngress.mockImplementation(
            native.dispatchRequiredConversationIngress,
          );
          restoreRequiredOwner = registerOwner;
        } catch (error) {
          await closeRequiredOwner();
          throw error;
        }
      }
      const dispatched = requiredOwner
        ? mockState.dispatchRequiredConversationIngress
        : mockState.dispatchInboundMessage;

      const activeProviders: Array<{ stop: () => Promise<void> }> = [];
      const startProvider = async () => {
        const socket = new FakeWebSocket();
        const abortController = new AbortController();
        const monitor = startTestMonitor(testConfig, abortController, socket);
        for (let tick = 0; tick < 20 && socket.openListenerCount === 0; tick += 1) {
          await Promise.resolve();
        }
        expect(socket.openListenerCount).toBeGreaterThan(0);
        socket.emitOpen();
        let stopped = false;
        const provider = {
          socket,
          stop: async () => {
            if (stopped) {
              return;
            }
            stopped = true;
            abortController.abort();
            socket.emitClose(1000);
            await monitor;
          },
        };
        activeProviders.push(provider);
        return provider;
      };
      const send = async (provider: Awaited<ReturnType<typeof startProvider>>) => {
        await emitMattermostChannelPost(provider.socket, {
          id: "post-abandon-retry",
          message: "retry me",
        });
      };
      const pendingAttempt = async (attempts: number) => {
        let observed: Awaited<ReturnType<typeof queue.listPending>>[number] | undefined;
        await vi.waitFor(async () => {
          const pending = await queue.listPending({ limit: "all" });
          expect(pending).toEqual([
            expect.objectContaining({
              id: "post-abandon-retry",
              attempts,
              lastAttemptAt: expect.any(Number),
              lastError: requiredOwner
                ? expect.stringContaining("Required conversation owner blocked")
                : "turn-abandoned",
            }),
          ]);
          observed = pending[0];
        });
        const lastAttemptAt = observed?.lastAttemptAt;
        if (lastAttemptAt === undefined) {
          throw new Error(`Missing Mattermost retry timestamp for attempt ${attempts}`);
        }
        return { ...observed, lastAttemptAt };
      };

      try {
        const first = await startProvider();
        await send(first);
        const firstAttempt = await pendingAttempt(1);
        expect(dispatched).toHaveBeenCalledTimes(1);
        await first.stop();

        vi.setSystemTime(firstAttempt.lastAttemptAt + 999);
        const blocked = await startProvider();
        await send(blocked);
        await vi.advanceTimersByTimeAsync(0);
        expect(dispatched).toHaveBeenCalledTimes(1);
        await blocked.stop();

        vi.setSystemTime(firstAttempt.lastAttemptAt + 1_001);
        const second = await startProvider();
        await send(second);
        const secondAttempt = await pendingAttempt(2);
        expect(dispatched).toHaveBeenCalledTimes(2);
        await second.stop();

        for (let attempt = 3; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
          const claim = await queue.claim("post-abandon-retry", { ownerId: `seed-${attempt}` });
          if (!claim) {
            throw new Error(`Expected Mattermost seed claim ${attempt}`);
          }
          await queue.release(claim, {
            lastError: "turn-abandoned",
            releasedAt: secondAttempt.lastAttemptAt,
          });
        }

        vi.setSystemTime(secondAttempt.lastAttemptAt + 64_001);
        const threshold = await startProvider();
        await send(threshold);
        const thresholdAttempt = await pendingAttempt(DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS);
        expect(dispatched).toHaveBeenCalledTimes(3);
        await threshold.stop();

        vi.setSystemTime(thresholdAttempt.lastAttemptAt + 128_001);
        const beyond = await startProvider();
        await send(beyond);
        const beyondAttempt = await pendingAttempt(DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS + 1);
        expect(dispatched).toHaveBeenCalledTimes(4);
        await beyond.stop();

        vi.setSystemTime(beyondAttempt.lastAttemptAt + 1_000);
        const blockedRestart = await startProvider();
        await send(blockedRestart);
        await vi.advanceTimersByTimeAsync(0);
        expect(dispatched).toHaveBeenCalledTimes(4);
        if (requiredOwner) {
          expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
        }
        await blockedRestart.stop();

        if (restoreRequiredOwner) {
          expect(nativeClaim).not.toHaveBeenCalled();
          await restoreRequiredOwner();
          vi.setSystemTime(beyondAttempt.lastAttemptAt + 1_000_000);
          const recovered = await startProvider();
          await vi.waitFor(async () => {
            expect(await queue.listPending({ limit: "all" })).toEqual([]);
          });
          expect(nativeClaim).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ messageId: "post-abandon-retry", conversationId: "chan-1" }),
            expect.objectContaining({
              pluginBinding: expect.objectContaining({ requiredOwner: true }),
            }),
          );
          await send(recovered);
          expect(nativeClaim).toHaveBeenCalledOnce();
          expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
          await recovered.stop();
        }
      } finally {
        await Promise.allSettled(activeProviders.map(async (provider) => await provider.stop()));
        mockState.ingressQueue = undefined;
        await closeRequiredOwner?.();
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        vi.useRealTimers();
      }
    },
  );
}
