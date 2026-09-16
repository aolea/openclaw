// Shared Mattermost inbound monitor test harness.
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import { vi } from "vitest";
import type { MattermostPost } from "./client.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";
import { monitorMattermostProvider } from "./monitor.js";
import type { OpenClawConfig, ReplyPayload, RuntimeEnv } from "./runtime-api.js";

export class FakeWebSocket {
  public readonly sent: string[] = [];
  private readonly openListeners: Array<() => void> = [];
  private readonly messageListeners: Array<(data: Buffer) => void | Promise<void>> = [];
  private readonly pongListeners: Array<(data: Buffer) => void> = [];
  private readonly closeListeners: Array<(code: number, reason: Buffer) => void> = [];
  private readonly errorListeners: Array<(err: unknown) => void> = [];

  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: Buffer) => void | Promise<void>): void;
  on(event: "pong", listener: (data: Buffer) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
  on(event: "open" | "message" | "pong" | "close" | "error", listener: unknown): void {
    if (event === "open") {
      this.openListeners.push(listener as () => void);
      return;
    }
    if (event === "message") {
      this.messageListeners.push(listener as (data: Buffer) => void | Promise<void>);
      return;
    }
    if (event === "pong") {
      this.pongListeners.push(listener as (data: Buffer) => void);
      return;
    }
    if (event === "close") {
      this.closeListeners.push(listener as (code: number, reason: Buffer) => void);
      return;
    }
    this.errorListeners.push(listener as (err: unknown) => void);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  ping(): void {}

  close(): void {}

  terminate(): void {
    this.emitClose(1000);
  }

  get openListenerCount(): number {
    return this.openListeners.length;
  }

  emitOpen(): void {
    for (const listener of this.openListeners) {
      listener();
    }
  }

  async emitMessage(payload: unknown): Promise<void> {
    const buffer = Buffer.from(JSON.stringify(payload), "utf8");
    await Promise.all(this.messageListeners.map((listener) => Promise.resolve(listener(buffer))));
  }

  emitClose(code: number, reason = ""): void {
    const buffer = Buffer.from(reason, "utf8");
    for (const listener of this.closeListeners) {
      listener(code, buffer);
    }
  }

  emitError(err: unknown): void {
    for (const listener of this.errorListeners) {
      listener(err);
    }
  }
}

const mockState = vi.hoisted(() => ({
  abortController: undefined as AbortController | undefined,
  createReplyDispatcherWithTyping: vi.fn(),
  createMattermostClient: vi.fn(),
  createMattermostDraftStream: vi.fn(),
  deliveryPlanObserver: vi.fn(),
  dispatchInboundMessage: vi.fn(),
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

export function createRuntimeCore(
  cfg: OpenClawConfig,
  routeOverride?: {
    accountId?: string;
    agentId?: string;
    lastRoutePolicy?: "main" | "session";
    mainSessionKey?: string;
    sessionKey?: string;
  },
  overrides: {
    inboundDebounceMs?: number;
    resolveInboundDebounceMs?: typeof resolveInboundDebounceMs;
    isControlCommandMessage?: (text?: string) => boolean;
    shouldComputeCommandAuthorized?: (text?: string) => boolean;
    shouldHandleTextCommands?: () => boolean;
    textHasControlCommand?: (text?: string) => boolean;
    createInboundDebouncer?: typeof createInboundDebouncer;
    verboseDebug?: (message: string) => void;
    chunkMarkdownTextWithMode?: (
      text: string,
      limit: number,
      mode: "length" | "newline",
    ) => string[];
    chunkMode?: "length" | "newline";
    textChunkLimit?: number;
  } = {},
) {
  type ReplyDispatcherOptions = {
    deliver: (payload: ReplyPayload, info: { kind: "tool" | "block" | "final" }) => Promise<void>;
  };
  mockState.createReplyDispatcherWithTyping.mockImplementation(
    (options: ReplyDispatcherOptions) => ({
      dispatcher: {},
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      markRunComplete: vi.fn(),
      options,
    }),
  );
  type RecordInboundSessionInput = {
    storePath: string;
    sessionKey: string;
    ctx: unknown;
    createIfMissing?: boolean;
    groupResolution?: unknown;
    onRecordError?: (error: unknown) => void;
    updateLastRoute?: {
      accountId?: string;
      channel?: string;
      mainDmOwnerPin?: {
        onSkip?: () => void;
        ownerRecipient?: string;
        senderRecipient?: string;
      };
      sessionKey?: string;
      to?: string;
    };
  };
  const recordInboundSession = vi.fn(async (_params: RecordInboundSessionInput) => {});
  const dispatchPlanForTest = vi.fn(
    async (turn: {
      cfg: OpenClawConfig;
      channel: string;
      route: { agentId: string; sessionKey: string };
      ctxPayload: { SessionKey?: string };
      dispatcherOptions?: Record<string, unknown>;
      delivery: {
        observeMessageSent?: true;
        deliver: (
          payload: ReplyPayload,
          info: { kind: "tool" | "block" | "final" },
        ) => Promise<unknown>;
        onError?: unknown;
      };
      replyOptions?: Record<string, unknown>;
      record?: {
        groupResolution?: unknown;
        createIfMissing?: boolean;
        updateLastRoute?: RecordInboundSessionInput["updateLastRoute"];
        onRecordError?: (err: unknown) => void;
      };
    }) => {
      mockState.deliveryPlanObserver(turn.delivery.observeMessageSent);
      await recordInboundSession({
        storePath: "/tmp/openclaw-test-sessions.json",
        sessionKey: turn.ctxPayload.SessionKey ?? turn.route.sessionKey,
        ctx: turn.ctxPayload,
        groupResolution: turn.record?.groupResolution,
        createIfMissing: turn.record?.createIfMissing,
        updateLastRoute: turn.record?.updateLastRoute,
        onRecordError: turn.record?.onRecordError ?? (() => undefined),
      });
      const prepared = mockState.createReplyDispatcherWithTyping({
        ...turn.dispatcherOptions,
        deliver: turn.delivery.deliver,
        onError: turn.delivery.onError,
      }) as { dispatcher: unknown; replyOptions?: Record<string, unknown> };
      const dispatchResult = await mockState.dispatchInboundMessage({
        ctx: turn.ctxPayload,
        cfg: turn.cfg,
        dispatcher: prepared.dispatcher,
        replyOptions: { ...prepared.replyOptions, ...turn.replyOptions },
        onSettled: turn.dispatcherOptions?.onSettled,
      });
      return {
        admission: { kind: "dispatch" as const },
        dispatched: true,
        ctxPayload: turn.ctxPayload,
        routeSessionKey: turn.route.sessionKey,
        dispatchResult,
      };
    },
  );
  const run = vi.fn(
    async (params: {
      raw: unknown;
      adapter: {
        ingest: (raw: unknown) => unknown;
        resolveTurn: (
          input: unknown,
          eventClass: { kind: "message"; canStartAgentTurn: true },
          preflight: Record<string, never>,
        ) => Parameters<typeof dispatchPlanForTest>[0];
      };
    }) => {
      const input = params.adapter.ingest(params.raw);
      const turn = params.adapter.resolveTurn(
        input,
        { kind: "message", canStartAgentTurn: true },
        {},
      );
      return await dispatchPlanForTest(turn);
    },
  );
  return {
    config: {
      current: () => cfg,
    },
    logging: {
      shouldLogVerbose: () => Boolean(overrides.verboseDebug),
      getChildLogger: () => ({
        debug: overrides.verboseDebug ?? vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    },
    media: {
      mediaKindFromMime: () => "document",
    },
    system: {
      enqueueSystemEvent: mockState.enqueueSystemEvent,
    },
    channel: {
      activity: {
        record: vi.fn(),
      },
      commands: {
        isControlCommandMessage: overrides.isControlCommandMessage ?? (() => false),
        shouldComputeCommandAuthorized: overrides.shouldComputeCommandAuthorized ?? (() => false),
        shouldHandleTextCommands: overrides.shouldHandleTextCommands ?? (() => false),
      },
      debounce: {
        resolveInboundDebounceMs:
          overrides.resolveInboundDebounceMs ?? (() => overrides.inboundDebounceMs ?? 0),
        createInboundDebouncer:
          overrides.createInboundDebouncer ??
          (<T>(params: {
            onFlush: (
              entries: T[],
              createFlush: typeof createTestInboundDebounceFlush,
            ) => { completion: Promise<void> };
          }) => ({
            enqueue: async (entry: T) => {
              await params.onFlush([entry], createTestInboundDebounceFlush).completion;
            },
            flushKey: async () => {},
            cancelKey: () => false,
            drain: async () => {},
          })),
      },
      groups: {
        resolveRequireMention: (params: { requireMentionOverride?: boolean }) =>
          params.requireMentionOverride ?? false,
      },
      media: {
        readRemoteMediaBuffer: vi.fn(),
        saveMediaBuffer: vi.fn(),
      },
      mentions: {
        buildMentionRegexes: () => [],
        matchesMentionPatterns: () => false,
      },
      pairing: {
        buildPairingReply: () => "pairing required",
      },
      reply: {
        settleReplyDispatcher: vi.fn(async ({ onSettled }) => onSettled?.()),
      },
      routing: {
        resolveAgentRoute: () => ({
          accountId: routeOverride?.accountId ?? "default",
          agentId: routeOverride?.agentId ?? "main",
          lastRoutePolicy: routeOverride?.lastRoutePolicy ?? "main",
          mainSessionKey: routeOverride?.mainSessionKey ?? "mattermost:default:channel:chan-1",
          sessionKey: routeOverride?.sessionKey ?? "mattermost:default:channel:chan-1",
        }),
      },
      session: {
        resolveStorePath: () => "/tmp/openclaw-test-sessions.json",
        recordInboundSession,
        updateLastRoute: vi.fn(async () => {}),
      },
      inbound: {
        run,
      },
      text: {
        chunkMarkdownTextWithMode:
          overrides.chunkMarkdownTextWithMode ?? ((text: string) => [text]),
        convertMarkdownTables: (text: string) => text,
        hasControlCommand: overrides.textHasControlCommand ?? (() => false),
        resolveChunkMode: () => overrides.chunkMode ?? "length",
        resolveMarkdownTableMode: () => "off",
        resolveTextChunkLimit: () => overrides.textChunkLimit ?? 4000,
      },
    },
  };
}

export const testConfig: OpenClawConfig = {
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

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => mockState.runtimeCore,
  getOptionalMattermostRuntime: () => mockState.runtimeCore,
}));

export const testRuntime = (): RuntimeEnv =>
  ({
    log: vi.fn(),
    error: vi.fn(),
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as RuntimeEnv["exit"],
  }) satisfies RuntimeEnv;

export function startTestMonitor(
  config: OpenClawConfig,
  abortController: AbortController,
  socket: FakeWebSocket,
): Promise<void> {
  return monitorMattermostProvider({
    config,
    runtime: testRuntime(),
    abortSignal: abortController.signal,
    webSocketFactory: () => socket,
  });
}

export async function emitMattermostChannelPost(
  socket: FakeWebSocket,
  params: {
    id: string;
    message: string;
    channelId?: string;
    rootId?: string;
    senderId?: string;
    senderName?: string;
    createAt?: number;
    type?: string;
  },
) {
  const senderId = params.senderId ?? "user-1";
  const channelId = params.channelId ?? "chan-1";
  await socket.emitMessage({
    event: "posted",
    data: {
      channel_id: channelId,
      channel_name: "town-square",
      channel_display_name: "Town Square",
      sender_name: params.senderName ?? "alice",
      post: JSON.stringify({
        id: params.id,
        channel_id: channelId,
        user_id: senderId,
        message: params.message,
        root_id: params.rootId,
        create_at: params.createAt ?? 1_714_000_000_000,
        type: params.type,
      }),
    },
    broadcast: {
      channel_id: channelId,
      user_id: senderId,
    },
  });
}

export function monitorMattermostProviderForTest(
  ...args: Parameters<typeof monitorMattermostProvider>
): ReturnType<typeof monitorMattermostProvider> {
  return monitorMattermostProvider(...args);
}

export function resetMattermostMonitorTestState(): void {
  vi.clearAllMocks();
  mockState.abortController = undefined;
  mockState.ingressQueue = undefined;
  mockState.progressDrafts.length = 0;
  mockState.getGlobalHookRunner.mockReturnValue(null);
  mockState.runtimeCore = createRuntimeCore(testConfig);
  mockState.createMattermostClient.mockReturnValue({});
  mockState.createMattermostDraftStream.mockReturnValue({
    update: vi.fn(),
    updateAssistantText: vi.fn(),
    flush: vi.fn(async () => {}),
    retainTerminalText: vi.fn(async () => false),
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
}

export { mockState };
