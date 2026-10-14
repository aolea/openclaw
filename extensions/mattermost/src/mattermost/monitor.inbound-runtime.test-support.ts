import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import type {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  createPluginRuntimeMock,
  createTestInboundDebounceFlush,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { vi, type Mock } from "vitest";
import { bindTestDeliveryObserver } from "./monitor.delivery.test-support.js";
import type { OpenClawConfig, ReplyPayload } from "./runtime-api.js";

type MattermostInboundRuntimeMocks = {
  createReplyDispatcherWithTyping: Mock;
  deliveryPlanObserver: Mock;
  dispatchInboundMessage: Mock;
  enqueueSystemEvent: Mock;
};

export function createMattermostInboundRuntimeCoreFactory(
  mockState: MattermostInboundRuntimeMocks,
) {
  return function createRuntimeCore(
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
      shouldHandleTextCommands?: () => boolean;
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
    type RecordInboundSessionInput = Parameters<
      PluginRuntime["channel"]["session"]["recordInboundSession"]
    >[0];
    const recordInboundSession = vi.fn(async (_params: RecordInboundSessionInput) => {});
    const dispatchPlanForTest = vi.fn(async (turn: ChannelInboundTurnPlan) => {
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
        deliver: bindTestDeliveryObserver(turn.delivery),
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
    });
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
          ingress: createPluginRuntimeMock().channel.inbound.ingress,
          run,
        },
        text: {
          chunkMarkdownTextWithMode:
            overrides.chunkMarkdownTextWithMode ?? ((text: string) => [text]),
          convertMarkdownTables: (text: string) => text,
          resolveChunkMode: () => overrides.chunkMode ?? "length",
          resolveMarkdownTableMode: () => "off",
          resolveTextChunkLimit: () => overrides.textChunkLimit ?? 4000,
        },
      },
    };
  };
}
