// Mattermost tests cover monitor.inbound system event plugin behavior.
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { createRuntimeEnv as testRuntime } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MattermostPost } from "./client.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";
import { registerMattermostBlockProgressTests } from "./monitor.block-progress.test-support.js";
import { createMattermostInboundRuntimeCoreFactory } from "./monitor.inbound-runtime.test-support.js";
import { monitorMattermostProvider } from "./monitor.js";
import { registerMattermostPreviewDeliveryTests } from "./monitor.preview-delivery.test-support.js";
import { registerMattermostPreviewPolicyTests } from "./monitor.preview-policy.test-support.js";
import {
  registerMattermostIngressRetryTests,
  registerMattermostRequiredOwnerAdmissionTests,
} from "./monitor.required-owner.test-support.js";
import type { OpenClawConfig, RuntimeEnv } from "./runtime-api.js";

class FakeWebSocket extends EventEmitter<{
  open: [];
  message: [Buffer];
  pong: [Buffer];
  close: [number, Buffer];
  error: [unknown];
}> {
  send(_data: string): void {}
  ping(): void {}
  close(): void {}
  terminate(): void {
    this.emitClose(1000);
  }
  get openListenerCount(): number {
    return this.listenerCount("open");
  }
  emitOpen(): void {
    this.emit("open");
  }
  async emitMessage(payload: unknown): Promise<void> {
    const buffer = Buffer.from(JSON.stringify(payload), "utf8");
    await Promise.all(
      this.listeners("message").map((listener) => Promise.resolve(listener(buffer))),
    );
  }
  emitClose(code: number, reason = ""): void {
    this.emit("close", code, Buffer.from(reason, "utf8"));
  }
}

const mockState = vi.hoisted(() => ({
  abortController: undefined as AbortController | undefined,
  createReplyDispatcherWithTyping: vi.fn(),
  createMattermostClient: vi.fn(),
  createMattermostDraftStream: vi.fn(),
  deliveryPlanObserver: vi.fn(),
  dispatchInboundMessage: vi.fn(),
  dispatchRequiredConversationIngress: vi.fn(),
  enqueueSystemEvent: vi.fn(),
  fetchMattermostMe: vi.fn(),
  getGlobalHookRunner: vi.fn(),
  ingressQueue: undefined as unknown,
  progressDrafts: [] as Array<{ getSnapshot: () => { lines: readonly unknown[] } }>,
  registerMattermostMonitorSlashCommands: vi.fn(),
  registerPluginHttpRoute: vi.fn(),
  recordMattermostThreadParticipation: vi.fn(),
  resolveChannelInfo: vi.fn(),
  resolveMattermostMedia: vi.fn(),
  resolveUserInfo: vi.fn(),
  runtimeCore: undefined as unknown,
  sendMessageMattermost: vi.fn(),
  updateMattermostPost: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  dispatchRequiredConversationIngress: mockState.dispatchRequiredConversationIngress,
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>()),
  getGlobalHookRunner: mockState.getGlobalHookRunner,
}));

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return {
    ...actual,
    createChannelProgressDraftCompositor: (
      ...args: Parameters<typeof actual.createChannelProgressDraftCompositor>
    ) => {
      const draft = actual.createChannelProgressDraftCompositor(...args);
      mockState.progressDrafts.push(draft);
      return draft;
    },
  };
});

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    createReplyDispatcherWithTyping: (...args: unknown[]) =>
      mockState.createReplyDispatcherWithTyping(...args),
    dispatchInboundMessage: async (params: Parameters<typeof actual.dispatchInboundMessage>[0]) => {
      try {
        return await mockState.dispatchInboundMessage(params);
      } finally {
        await params.onSettled?.();
      }
    },
  };
});

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createMattermostClient: mockState.createMattermostClient,
    fetchMattermostMe: mockState.fetchMattermostMe,
    normalizeMattermostBaseUrl: (value: string | undefined) => value?.trim() ?? "",
    updateMattermostPost: mockState.updateMattermostPost,
  };
});

vi.mock("./draft-stream.js", async () => {
  const actual = await vi.importActual<typeof import("./draft-stream.js")>("./draft-stream.js");
  return {
    ...actual,
    createMattermostDraftStream: mockState.createMattermostDraftStream,
  };
});

vi.mock("./monitor-resources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor-resources.js")>()),
  createMattermostMonitorResources: () => ({
    resolveMattermostMedia: mockState.resolveMattermostMedia,
    sendTypingIndicator: vi.fn(async () => {}),
    resolveChannelInfo: mockState.resolveChannelInfo,
    resolveUserInfo: mockState.resolveUserInfo,
    updateModelPickerPost: vi.fn(async () => {}),
  }),
}));

vi.mock("./monitor-ingress.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./monitor-ingress.js")>();
  return {
    ...actual,
    createMattermostIngressMonitor: (
      options: Parameters<typeof actual.createMattermostIngressMonitor>[0],
    ) => {
      if (mockState.ingressQueue) {
        return actual.createMattermostIngressMonitor({
          ...options,
          queue: mockState.ingressQueue as NonNullable<typeof options.queue>,
          pollIntervalMs: 60_000,
        });
      }
      return {
        receive: async (rawEvent: string) => {
          const payload = JSON.parse(rawEvent) as MattermostEventPayload;
          const post =
            typeof payload.data?.post === "string"
              ? (JSON.parse(payload.data.post) as MattermostPost)
              : (payload.data?.post as MattermostPost | undefined);
          if (payload.event !== "posted" || !post) {
            return;
          }
          const senderId = post.user_id?.trim();
          if (!senderId) {
            throw new Error("Mattermost posted event is missing post.user_id");
          }
          await options.dispatch({ ...post, user_id: senderId }, payload, {
            abortSignal: new AbortController().signal,
            onAdopted: async () => {},
            onDeferred: () => {},
            onAdoptionFinalizing: () => {},
            onAbandoned: async () => {},
          });
        },
        stop: async () => {},
        waitForIdle: async () => {},
      };
    },
  };
});

vi.mock("./monitor-slash.js", () => ({
  registerMattermostMonitorSlashCommands: mockState.registerMattermostMonitorSlashCommands,
}));

vi.mock("./thread-participation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thread-participation.js")>()),
  recordMattermostThreadParticipation: mockState.recordMattermostThreadParticipation,
}));

vi.mock("./runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-api.js")>("./runtime-api.js");
  return {
    ...actual,
    buildAgentMediaPayload: vi.fn(() => ({})),
    createChannelPairingController: vi.fn(() => ({
      readStoreForDmPolicy: vi.fn(async () => []),
      upsertPairingRequest: vi.fn(async () => ({ code: "123456", created: true })),
    })),
    createChannelMessageReplyPipeline: vi.fn((params: { cfg: OpenClawConfig }) => ({
      onModelSelected: vi.fn(),
      typingCallbacks: {},
      resolveResponsePrefix: () => params.cfg.channels?.mattermost?.responsePrefix,
    })),
    registerPluginHttpRoute: mockState.registerPluginHttpRoute,
    resolveChannelMediaMaxBytes: vi.fn(() => 8 * 1024 * 1024),
    warnMissingProviderGroupPolicyFallbackOnce: vi.fn(),
  };
});

vi.mock("./send.js", async () => {
  const actual = await vi.importActual<typeof import("./send.js")>("./send.js");
  return {
    ...actual,
    sendMessageMattermost: mockState.sendMessageMattermost,
  };
});

const createRuntimeCore = createMattermostInboundRuntimeCoreFactory(mockState);

const testConfig: OpenClawConfig = {
  channels: {
    mattermost: {
      enabled: true,
      baseUrl: "https://mattermost.example.com",
      botToken: "bot-token",
      chatmode: "onmessage",
      dmPolicy: "open",
      groupPolicy: "open",
    },
  },
};

function mattermostConfig(
  mattermost: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["mattermost"]>>,
  config: OpenClawConfig = {},
): OpenClawConfig {
  return {
    ...config,
    channels: {
      ...config.channels,
      mattermost: { ...testConfig.channels?.mattermost, ...mattermost },
    },
  };
}

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => mockState.runtimeCore,
  getOptionalMattermostRuntime: () => mockState.runtimeCore,
}));

function startTestMonitor(
  config: OpenClawConfig,
  abortController: AbortController,
  socket: FakeWebSocket,
  runtime: RuntimeEnv = testRuntime(),
): Promise<void> {
  return monitorMattermostProvider({
    config,
    runtime,
    abortSignal: abortController.signal,
    webSocketFactory: () => socket,
  });
}

async function openMonitor(
  socket: FakeWebSocket,
  abortController: AbortController,
  config: OpenClawConfig = testConfig,
  runtime: RuntimeEnv = testRuntime(),
) {
  const monitor = startTestMonitor(config, abortController, socket, runtime);
  await vi.waitFor(() => {
    expect(socket.openListenerCount).toBeGreaterThan(0);
  });
  socket.emitOpen();
  return { monitor };
}

function mattermostPostEvent(params: {
  id: string;
  message: string;
  channelId?: string;
  postChannelId?: string;
  rootId?: string;
  senderId?: string;
  senderName?: string;
  createAt?: number;
  updateAt?: number;
  type?: string;
  fileIds?: string[];
  channelType?: string;
  includeChannelLabels?: boolean;
}) {
  const senderId = params.senderId ?? "user-1";
  const channelId = params.channelId ?? "chan-1";
  return {
    event: "posted",
    data: {
      channel_id: channelId,
      ...(params.includeChannelLabels === false
        ? {}
        : { channel_name: "town-square", channel_display_name: "Town Square" }),
      channel_type: params.channelType,
      sender_name: params.senderName ?? "alice",
      post: JSON.stringify({
        id: params.id,
        channel_id: params.postChannelId ?? channelId,
        user_id: senderId,
        message: params.message,
        root_id: params.rootId,
        create_at: params.createAt ?? 1_714_000_000_000,
        update_at: params.updateAt,
        type: params.type,
        file_ids: params.fileIds,
      }),
    },
    broadcast: {
      channel_id: channelId,
      user_id: senderId,
    },
  };
}
async function emitMattermostChannelPost(
  socket: FakeWebSocket,
  post: Parameters<typeof mattermostPostEvent>[0],
) {
  await socket.emitMessage(mattermostPostEvent(post));
}

async function receivePost(
  post: Parameters<typeof emitMattermostChannelPost>[1],
  config: OpenClawConfig = testConfig,
  runtime: RuntimeEnv = testRuntime(),
): Promise<ChannelInboundTurnPlan["ctxPayload"] | undefined> {
  const socket = new FakeWebSocket();
  const abortController = new AbortController();
  mockState.abortController = abortController;
  const { monitor } = await openMonitor(socket, abortController, config, runtime);
  try {
    await emitMattermostChannelPost(socket, post);
  } finally {
    abortController.abort();
    socket.emitClose(1000);
    await monitor;
  }
  return mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
}

describe("mattermost inbound user posts", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.abortController = undefined;
    mockState.ingressQueue = undefined;
    mockState.progressDrafts.length = 0;
    mockState.getGlobalHookRunner.mockReturnValue(null);
    mockState.dispatchRequiredConversationIngress.mockResolvedValue({ status: "unmanaged" });
    mockState.runtimeCore = createRuntimeCore(testConfig);
    mockState.createMattermostClient.mockReturnValue({});
    mockState.createMattermostDraftStream.mockReturnValue({
      update: vi.fn(),
      updateAssistantText: vi.fn(),
      flush: vi.fn(async () => {}),
      postId: vi.fn(() => undefined),
      clear: vi.fn(async () => {}),
      discardPending: vi.fn(async () => {}),
      seal: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      settleBoundaries: vi.fn(async () => {}),
      resolveFinalText: (text: string) => ({ kind: "full" as const, text, publishedParts: [] }),
    });
    mockState.fetchMattermostMe.mockResolvedValue({
      id: "bot-user",
      username: "openclaw",
      update_at: 1,
    });
    mockState.registerMattermostMonitorSlashCommands.mockResolvedValue(undefined);
    mockState.registerPluginHttpRoute.mockReturnValue(vi.fn());
    mockState.resolveChannelInfo.mockResolvedValue({
      id: "chan-1",
      name: "town-square",
      display_name: "Town Square",
      team_id: "team-1",
      type: "O",
    });
    mockState.resolveMattermostMedia.mockResolvedValue([]);
    mockState.resolveUserInfo.mockResolvedValue({ id: "user-1", username: "alice" });
    mockState.sendMessageMattermost.mockResolvedValue({});
    mockState.dispatchInboundMessage.mockImplementation(async () => {
      mockState.abortController?.abort();
    });
  });

  it.each(["reply_payload_sending", "message_sending"])(
    "keeps terminal progress disabled by the %s hook while delivering the error final",
    async (hook) => {
      const config = mattermostConfig({
        streaming: { mode: "progress", progress: { finalDelivery: "separate" } },
      });
      const verboseDebug = vi.fn();
      mockState.runtimeCore = createRuntimeCore(config, undefined, { verboseDebug });
      mockState.getGlobalHookRunner.mockReturnValue({
        hasHooks: (name: string) => name === hook,
      });
      mockState.sendMessageMattermost.mockResolvedValue({
        content: "Task failed.",
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "mattermost", channelId: "chan-1", messageId: "error-final" }],
          kind: "text",
        }),
      });
      mockState.dispatchInboundMessage.mockImplementation(async () => {
        try {
          const options =
            mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
          await options?.deliver({ text: "Task failed.", isError: true }, { kind: "final" });
        } finally {
          mockState.abortController?.abort();
        }
      });

      await receivePost({ id: `post-error-${hook}`, message: "run this" }, config);

      expect(mockState.createMattermostDraftStream).not.toHaveBeenCalled();
      expect(mockState.sendMessageMattermost).toHaveBeenCalledOnce();
      expect(verboseDebug.mock.calls.flat().join("\n")).not.toContain(
        "mattermost terminal progress update failed",
      );
    },
  );

  const ingressHarness = {
    testConfig,
    createRuntimeCore,
    FakeWebSocket,
    openMonitor,
    startTestMonitor,
    emitMattermostChannelPost,
    tempDirs,
    mockState,
  };
  registerMattermostRequiredOwnerAdmissionTests(ingressHarness);

  it("changes Mattermost delay at collector admission without replacing the socket", async () => {
    const cfg = { ...testConfig, messages: { inbound: { debounceMs: 0 } } };
    setRuntimeConfigSnapshot(cfg, cfg);
    mockState.dispatchInboundMessage.mockResolvedValue(undefined);
    mockState.runtimeCore = createRuntimeCore(cfg, undefined, {
      createInboundDebouncer,
      resolveInboundDebounceMs,
    });
    const socket = new FakeWebSocket();
    const abort = new AbortController();
    const socketFactory = vi.fn(() => socket);
    const monitor = monitorMattermostProvider({
      config: cfg,
      runtime: testRuntime(),
      abortSignal: abort.signal,
      webSocketFactory: socketFactory,
    });
    await vi.waitFor(() => expect(socket.openListenerCount).toBeGreaterThan(0));
    socket.emitOpen();
    const bodies = () =>
      mockState.dispatchInboundMessage.mock.calls.map(([params]) => params.ctx.BodyForAgent);
    const publish = (debounceMs: number) => {
      const current = { ...cfg, messages: { inbound: { byChannel: { mattermost: debounceMs } } } };
      setRuntimeConfigSnapshot(current, current);
    };
    try {
      await emitMattermostChannelPost(socket, { id: "debounce-1", message: "immediate" });
      await vi.waitFor(() => expect(bodies()).toEqual(["immediate"]));
      publish(500);
      await emitMattermostChannelPost(socket, { id: "debounce-2", message: "buffered" });
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(bodies()).toEqual(["immediate"]);
      publish(0);
      await vi.waitFor(() => expect(bodies()).toEqual(["immediate", "buffered"]));
      await emitMattermostChannelPost(socket, { id: "debounce-3", message: "after disable" });
      await vi.waitFor(() => expect(bodies()).toEqual(["immediate", "buffered", "after disable"]));
      expect(socketFactory).toHaveBeenCalledTimes(1);
    } finally {
      abort.abort();
      socket.emitClose(1000);
      await monitor;
      clearRuntimeConfigSnapshot();
    }
  });

  registerMattermostIngressRetryTests(ingressHarness);

  it("publishes recovering while API authentication retries, including 401", async () => {
    const abortController = new AbortController();
    const statusSink = vi.fn();
    mockState.fetchMattermostMe.mockRejectedValue(new Error("HTTP 401 Unauthorized"));

    const monitor = monitorMattermostProvider({
      config: testConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      statusSink,
    });

    await vi.waitFor(() => {
      expect(statusSink).toHaveBeenCalledWith({
        connected: false,
        lifecycle: "recovering",
        lastError: "Error: HTTP 401 Unauthorized",
      });
    });
    abortController.abort();
    await monitor;
  });

  it.each(["interactions", "slash"] as const)(
    "does not open a websocket after %s startup fails",
    async (stage) => {
      const unregisterInteractions = vi.fn();
      const statusSink = vi.fn();
      const webSocketFactory = vi.fn(() => new FakeWebSocket());
      const failure = new Error(`Mattermost ${stage} setup failed`);
      if (stage === "interactions") {
        mockState.registerPluginHttpRoute.mockImplementationOnce(() => {
          throw failure;
        });
      } else {
        mockState.registerPluginHttpRoute.mockReturnValueOnce(unregisterInteractions);
        mockState.registerMattermostMonitorSlashCommands.mockRejectedValueOnce(failure);
      }
      await expect(
        monitorMattermostProvider({
          config: testConfig,
          runtime: testRuntime(),
          abortSignal: new AbortController().signal,
          statusSink,
          webSocketFactory,
        }),
      ).rejects.toThrow(failure.message);
      if (stage === "interactions") {
        expect(mockState.registerPluginHttpRoute).toHaveBeenCalledWith(
          expect.objectContaining({
            accountId: "default",
            pluginId: "mattermost",
            source: "mattermost-interactions",
            throwOnFailure: true,
          }),
        );
        expect(mockState.registerPluginHttpRoute.mock.calls[0]?.[0]).not.toHaveProperty(
          "replaceExisting",
        );
        expect(mockState.registerMattermostMonitorSlashCommands).not.toHaveBeenCalled();
      } else {
        expect(unregisterInteractions).toHaveBeenCalledOnce();
      }
      expect(webSocketFactory).not.toHaveBeenCalled();
      expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
    },
  );

  it.each([1, 2])("dispatches ordered attachments (%i files)", async (fileCount) => {
    const media = [
      { contentType: "application/pdf", fileName: "quarterly report.pdf", kind: "document" },
      { path: "/tmp/mattermost-attachment.png", contentType: "image/png", kind: "image" },
    ].slice(0, fileCount);
    mockState.resolveMattermostMedia.mockResolvedValueOnce(media);
    const ctx = await receivePost({
      id: "post-regular",
      message: "hello from mattermost",
      fileIds: ["file-1", "image-1"].slice(0, fileCount),
    });
    expect(mockState.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(mockState.deliveryPlanObserver).toHaveBeenCalledExactlyOnceWith(true);
    expect(ctx).toMatchObject({
      BodyForAgent:
        'hello from mattermost\n\n[mattermost attachment unavailable] "quarterly report.pdf"',
      ConversationLabel: "Town Square id:chan-1",
      MessageSid: "post-regular",
      ConversationRouteContextObserved: true,
      ConversationRoutePeerId: "chan-1",
      GroupSpace: "team-1",
      NativeChannelId: "chan-1",
      InboundAccessAuthorized: true,
      OriginatingChannel: "mattermost",
      Provider: "mattermost",
    });
    expect(ctx?.media).toEqual(media.map((attachment) => expect.objectContaining(attachment)));
    expect(ctx?.media?.[0]?.path).toBeUndefined();
    expect(ctx?.media?.[0]?.url).toBeUndefined();
  });

  it.each([
    { name: "default visibility", contextVisibility: undefined, expectedHistory: true },
    { name: "allowlist visibility", contextVisibility: "allowlist", expectedHistory: false },
  ] as const)(
    "preserves denied history policy over authenticated Mattermost HTTP and WebSocket with $name",
    async ({ contextVisibility, expectedHistory }) => {
      const token = "mattermost-loopback-proof-token";
      const requests: Array<{ path: string; authorization?: string }> = [];
      const server = createServer((request, response) => {
        requests.push({
          path: request.url ?? "",
          authorization: request.headers.authorization,
        });
        response.setHeader("content-type", "application/json");
        if (request.headers.authorization !== `Bearer ${token}`) {
          response.writeHead(401);
          response.end(JSON.stringify({ message: "unauthorized" }));
          return;
        }
        if (request.url === "/api/v4/users/me") {
          response.end(JSON.stringify({ id: "bot-user", username: "openclaw", update_at: 1 }));
          return;
        }
        if (request.url === "/api/v4/channels/chan-1") {
          response.end(
            JSON.stringify({
              id: "chan-1",
              name: "town-square",
              display_name: "Town Square",
              team_id: "team-1",
              type: "O",
            }),
          );
          return;
        }
        response.writeHead(404);
        response.end(JSON.stringify({ message: "unknown loopback endpoint" }));
      });
      const websocket = new WebSocketServer({ server, path: "/api/v4/websocket" });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a Mattermost loopback TCP address");
      }

      const abortController = new AbortController();
      mockState.abortController = abortController;
      const verboseDebug = vi.fn();
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const config: OpenClawConfig = {
        agents: { defaults: { envelopeTimezone: "user", userTimezone: "Asia/Jakarta" } },
        messages: { groupChat: { historyLimit: 2 } },
        channels: {
          ...(contextVisibility ? { defaults: { contextVisibility } } : {}),
          mattermost: {
            enabled: true,
            baseUrl,
            botToken: token,
            chatmode: "onmessage",
            dmPolicy: "open",
            groupPolicy: "allowlist",
            groupAllowFrom: ["allowed-user"],
            network: { dangerouslyAllowPrivateNetwork: true },
          },
        },
      };
      const isControlCommandMessage = vi.fn((text?: string) => text?.trim() === "/reset");
      const runtimeCore = createRuntimeCore(config, undefined, {
        verboseDebug,
        isControlCommandMessage,
        shouldHandleTextCommands: () => true,
      });
      mockState.runtimeCore = runtimeCore;
      const actualClient = await vi.importActual<typeof import("./client.js")>("./client.js");
      mockState.createMattermostClient.mockImplementation(actualClient.createMattermostClient);
      mockState.fetchMattermostMe.mockImplementation(actualClient.fetchMattermostMe);
      mockState.resolveChannelInfo.mockImplementation(async (channelId: string) => {
        const client = mockState.createMattermostClient.mock.results.at(-1)?.value;
        if (!client) {
          throw new Error("expected the production Mattermost HTTP client");
        }
        return await actualClient.fetchMattermostChannel(client, channelId);
      });

      const connection = once(websocket, "connection");
      let monitor: Promise<void> | undefined;
      try {
        monitor = monitorMattermostProvider({
          config,
          runtime: testRuntime(),
          abortSignal: abortController.signal,
        });
        const [socket] = await connection;
        const [rawAuthentication] = await once(socket, "message");
        expect(JSON.parse(String(rawAuthentication))).toMatchObject({
          action: "authentication_challenge",
          data: { token },
        });

        const sendPost = (post: Parameters<typeof mattermostPostEvent>[0]) => {
          socket.send(JSON.stringify(mattermostPostEvent(post)));
        };

        for (const [index, message] of ["/reset", "denied second", "denied third"].entries()) {
          sendPost({
            id: `loopback-denied-${index}`,
            message,
            senderId: "denied-user",
          });
          await vi.waitFor(() => {
            const drops = verboseDebug.mock.calls.filter(([line]) =>
              String(line).includes("drop group sender=denied-user"),
            );
            expect(drops).toHaveLength(index + 1);
          });
          expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
          expect(runtimeCore.channel.session.recordInboundSession).not.toHaveBeenCalled();
          expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
          expect(mockState.createReplyDispatcherWithTyping).not.toHaveBeenCalled();
        }

        sendPost({
          id: "loopback-allowed",
          message: "summarize the conversation",
          senderId: "allowed-user",
          createAt: 1_714_003_600_000,
        });
        await vi.waitFor(() => {
          expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
        });

        const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
        expect(ctx?.SenderId).toBe("allowed-user");
        expect(ctx?.BodyForAgent).toBe("summarize the conversation");
        expect(ctx?.InboundHistory?.map((entry: { body: string }) => entry.body) ?? []).toEqual(
          expectedHistory ? ["denied second", "denied third"] : [],
        );
        expect(isControlCommandMessage).toHaveBeenCalledWith("/reset", config);
        expect(ctx?.CommandSource).toBeUndefined();
        expect(ctx?.Body).not.toContain("/reset");
        expect(ctx?.Body).toContain("Thu 2024-04-25 07:06:40");
        if (expectedHistory) {
          expect(ctx?.Body).toContain("Thu 2024-04-25 06:06:40");
          expect(ctx?.Body).toContain("denied second");
          expect(ctx?.Body).toContain("denied third");
        } else {
          expect(ctx?.Body).not.toContain("denied second");
          expect(ctx?.Body).not.toContain("denied third");
        }
        expect(requests.length).toBeGreaterThanOrEqual(4);
        expect(requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
        expect(requests.some((request) => request.path === "/api/v4/users/me")).toBe(true);
        expect(requests.some((request) => request.path === "/api/v4/channels/chan-1")).toBe(true);
      } finally {
        abortController.abort();
        for (const client of websocket.clients) {
          client.terminate();
        }
        if (monitor) {
          await monitor;
        }
        await new Promise<void>((resolve, reject) => {
          websocket.close((error) => (error ? reject(error) : resolve()));
        });
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it("keeps verbose inbound previews on complete UTF-16 boundaries", async () => {
    const verboseDebug = vi.fn();
    mockState.runtimeCore = createRuntimeCore(testConfig, undefined, { verboseDebug });
    await receivePost({ id: "post-verbose-preview", message: `${"a".repeat(199)}😀tail` });
    expect(verboseDebug).toHaveBeenCalledWith(
      `mattermost inbound: from=mattermost:channel:chan-1 len=205 preview="${"a".repeat(199)}"`,
    );
  });

  it("dispatches a bare bot mention as a wake event", async () => {
    const ctx = await receivePost({ id: "post-bare-mention", message: "@openclaw" });
    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(ctx).toMatchObject({
      BodyForAgent: "@openclaw",
      MessageSid: "post-bare-mention",
      OriginatingChannel: "mattermost",
      Provider: "mattermost",
    });
  });

  it.each([
    { message: "@openclaw:remote.example hello", expectedBody: null },
    { message: "hello.@openclaw", expectedBody: "hello." },
  ])(
    "dispatches only genuine mention-required posts: $message",
    async ({ message, expectedBody }) => {
      const runtime = testRuntime();
      const config = mattermostConfig({ chatmode: undefined, requireMention: true });
      mockState.runtimeCore = createRuntimeCore(config);
      const ctx = await receivePost(
        { id: "post-mention-boundary", message, channelId: "mention-boundary" },
        config,
        runtime,
      );
      if (expectedBody === null) {
        expect(runtime.log).toHaveBeenCalledWith(
          expect.stringContaining("mattermost: drop no mention target=mention-boundary"),
        );
        expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
      } else {
        expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
        expect(ctx?.BodyForAgent).toBe(expectedBody);
        expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("drop no mention"));
      }
    },
  );

  it("does not drop inline command-looking text from non-command-authorized senders", async () => {
    const isControlCommandMessage = vi.fn(() => false);
    mockState.runtimeCore = createRuntimeCore(testConfig, undefined, {
      isControlCommandMessage,
      shouldHandleTextCommands: () => true,
    });
    const ctx = await receivePost({ id: "post-inline-command", message: "hello /status" });
    expect(isControlCommandMessage).toHaveBeenCalledWith("hello /status", testConfig);
    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(ctx).toMatchObject({ BodyForAgent: "hello /status", CommandAuthorized: false });
    expect(ctx?.CommandSource).toBeUndefined();
  });

  it("routes a mention-prefixed text command without debouncing", async () => {
    const config = mattermostConfig(
      { chatmode: "oncall", groupAllowFrom: ["user-1"] },
      { messages: { inbound: { debounceMs: 60_000 } } },
    );
    const isControlCommandMessage = vi.fn((text?: string) => text?.trim() === "/reset");
    mockState.runtimeCore = createRuntimeCore(config, undefined, {
      inboundDebounceMs: 60_000,
      createInboundDebouncer,
      isControlCommandMessage,
      shouldHandleTextCommands: () => true,
    });
    const ctx = await receivePost(
      { id: "post-mention-command", message: "@openclaw /reset" },
      config,
    );
    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(isControlCommandMessage).toHaveBeenCalledWith("/reset", config);
    expect(ctx).toMatchObject({
      WasMentioned: true,
      BodyForAgent: "/reset",
      CommandBody: "/reset",
      CommandAuthorized: true,
      CommandSource: "text",
    });
  });

  it.each(["O", undefined])(
    "requires a trusted channel type, using websocket fallback %s",
    async (channelType) => {
      const config = mattermostConfig({ dmPolicy: "allowlist", allowFrom: ["trusted-user"] });
      const runtimeCore = createRuntimeCore(config);
      mockState.runtimeCore = runtimeCore;
      mockState.resolveChannelInfo.mockResolvedValue(null);
      const ctx = await receivePost(
        { id: "post-channel-kind", message: "hello", senderId: "new-user", channelType },
        config,
      );
      if (channelType) {
        expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
        expect(ctx).toMatchObject({
          BodyForAgent: "hello",
          ChatType: "channel",
          ConversationLabel: "Town Square id:chan-1",
        });
        expect(runtimeCore.channel.session.recordInboundSession).toHaveBeenCalledTimes(1);
      } else {
        expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
        expect(runtimeCore.channel.session.recordInboundSession).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["system_join_channel", "custom_openclaw_progress"])(
    "does not debounce denied senders or %s posts into an allowed human turn",
    async (postType) => {
      const socket = new FakeWebSocket();
      const abortController = new AbortController();
      const config = mattermostConfig(
        { groupPolicy: "allowlist", groupAllowFrom: ["allowed-user"] },
        { channels: { defaults: { contextVisibility: "allowlist" } } },
      );
      mockState.runtimeCore = createRuntimeCore(config, undefined, {
        inboundDebounceMs: 10,
        createInboundDebouncer,
      });
      const { monitor } = await openMonitor(socket, abortController, config);
      await emitMattermostChannelPost(socket, {
        id: "post-denied",
        message: "denied text",
        senderId: "denied-user",
        senderName: "mallory",
      });
      await emitMattermostChannelPost(socket, {
        id: "post-system",
        message: "Working\n\nTemporary progress",
        senderId: "allowed-user",
        type: postType,
      });
      await emitMattermostChannelPost(socket, {
        id: "post-allowed",
        message: "Working\n\nPlease review",
        senderId: "allowed-user",
      });
      await vi.waitFor(() => expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1));
      abortController.abort();
      socket.emitClose(1000);
      await monitor;
      const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
      expect(ctx).toMatchObject({
        SenderId: "allowed-user",
        BodyForAgent: "Working\n\nPlease review",
      });
      expect(ctx?.Body).not.toContain("denied text");
      expect(ctx?.Body).not.toContain("Temporary progress");
    },
  );

  it("flushes pending group text before authorizing a bare abort without a mention", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const config = mattermostConfig(
      { chatmode: "oncall", groupAllowFrom: ["user-1"] },
      { messages: { inbound: { debounceMs: 60_000 } } },
    );
    const isBareAbort = (text?: string) => ["abort", "stop"].includes(text?.trim() ?? "");
    mockState.runtimeCore = createRuntimeCore(config, undefined, {
      inboundDebounceMs: 60_000,
      createInboundDebouncer,
      isControlCommandMessage: isBareAbort,
      shouldHandleTextCommands: () => true,
    });
    const { monitor } = await openMonitor(socket, abortController, config);
    await emitMattermostChannelPost(socket, { id: "post-pending", message: "pending text" });
    expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
    await emitMattermostChannelPost(socket, {
      id: "post-abort",
      message: "abort",
      createAt: 1_714_000_000_100,
    });
    socket.emitClose(1000);
    await monitor;
    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx).toMatchObject({
      BodyForAgent: "abort",
      CommandAuthorized: true,
    });
  });

  it.each(["main", "session"] as const)(
    "keeps direct-message route updates on the %s owner",
    async (lastRoutePolicy) => {
      const isolated = lastRoutePolicy === "session";
      const sessionKey = isolated
        ? "agent:main:mattermost:direct:user-1"
        : "mattermost:default:channel:chan-1";
      const config = mattermostConfig(
        { dmPolicy: "allowlist", allowFrom: ["user-1"] },
        isolated ? { session: { dmScope: "per-channel-peer" } } : {},
      );
      const runtimeCore = createRuntimeCore(config, {
        lastRoutePolicy,
        mainSessionKey: isolated ? "agent:main:main" : sessionKey,
        sessionKey,
      });
      mockState.runtimeCore = runtimeCore;
      mockState.resolveChannelInfo.mockResolvedValue({
        id: "dm-1",
        name: "",
        display_name: "",
        team_id: "team-1",
        type: "D",
      });
      await receivePost(
        { id: "post-dm", message: "direct hello", channelId: "dm-1", includeChannelLabels: false },
        config,
      );
      expect(runtimeCore.channel.session.recordInboundSession).toHaveBeenCalledTimes(1);
      const [record] = runtimeCore.channel.session.recordInboundSession.mock.calls.at(0) ?? [];
      expect(record).toMatchObject({
        storePath: "/tmp/openclaw-test-sessions.json",
        sessionKey,
        updateLastRoute: {
          sessionKey,
          channel: "mattermost",
          to: "user:user-1",
          accountId: "default",
        },
      });
      if (isolated) {
        expect(record?.updateLastRoute?.sessionKey).not.toBe("agent:main:main");
        expect(record?.updateLastRoute?.mainDmOwnerPin).toBeUndefined();
      } else {
        expect(record?.updateLastRoute?.mainDmOwnerPin).toMatchObject({
          ownerRecipient: "user-1",
          senderRecipient: "user-1",
          onSkip: expect.any(Function),
        });
        expect(record?.createIfMissing).toBeUndefined();
        expect(record?.groupResolution).toBeUndefined();
        expect(record?.onRecordError).toBeInstanceOf(Function);
      }
    },
  );

  const harness = { testConfig, createRuntimeCore, receivePost, mockState };
  registerMattermostPreviewPolicyTests(harness);
  registerMattermostBlockProgressTests(harness);
  registerMattermostPreviewDeliveryTests(harness);
});
