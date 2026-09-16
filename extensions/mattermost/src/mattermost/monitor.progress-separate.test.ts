import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
// Mattermost tests cover progress post filtering and separate-final delivery.
import {
  FakeWebSocket,
  createRuntimeCore,
  emitMattermostChannelPost,
  mockState,
  monitorMattermostProviderForTest as monitorMattermostProvider,
  resetMattermostMonitorTestState,
  testConfig,
  testRuntime,
} from "./monitor.inbound-system-event.test-support.js";
import type { OpenClawConfig } from "./runtime-api.js";

describe("mattermost progress and separate final delivery", () => {
  beforeEach(() => {
    resetMattermostMonitorTestState();
  });

  it("drops typed OpenClaw progress posts before inbound routing", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    const runtimeCore = createRuntimeCore(testConfig);
    mockState.runtimeCore = runtimeCore;

    const monitor = monitorMattermostProvider({
      config: testConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "openclaw-progress-post",
      message: "|\n\nWorking...",
      senderId: "peer-openclaw-bot",
      senderName: "peer-openclaw",
      type: "custom_openclaw_progress",
    });
    abortController.abort();
    await monitor;

    expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
    expect(runtimeCore.channel.session.recordInboundSession).not.toHaveBeenCalled();
    expect(mockState.resolveChannelInfo).not.toHaveBeenCalled();
    expect(mockState.resolveUserInfo).not.toHaveBeenCalled();
  });

  it.each([
    ["typed progress before human text", ["typed", "human"]],
    ["typed progress after human text", ["human", "typed"]],
  ])("keeps debounced human input isolated when %s", async (_label, order) => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    const debounceConfig: OpenClawConfig = {
      messages: { inbound: { debounceMs: 60_000 } },
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
    const runtimeCore = createRuntimeCore(debounceConfig, undefined, {
      inboundDebounceMs: 60_000,
      createInboundDebouncer,
      isControlCommandMessage: (text) => text?.trim() === "abort",
    });
    mockState.runtimeCore = runtimeCore;
    mockState.dispatchInboundMessage.mockResolvedValue(undefined);

    const monitor = monitorMattermostProvider({
      config: debounceConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });
    await vi.waitFor(() => expect(socket.openListenerCount).toBeGreaterThan(0));
    socket.emitOpen();

    for (const kind of order) {
      await emitMattermostChannelPost(socket, {
        id: kind === "typed" ? "peer-progress" : "human-question",
        message: kind === "typed" ? "|\n\nWorking..." : "human question",
        senderId: kind === "typed" ? "peer-openclaw-bot" : "user-1",
        senderName: kind === "typed" ? "peer-openclaw" : "alice",
        ...(kind === "typed" ? { type: "custom_openclaw_progress" } : {}),
      });
    }
    await emitMattermostChannelPost(socket, {
      id: "human-abort",
      message: "abort",
    });
    await vi.waitFor(() => expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(2));
    abortController.abort();
    socket.emitClose(1000);
    await monitor;

    const contexts = mockState.dispatchInboundMessage.mock.calls.map((call) => call[0].ctx);
    expect(contexts.map((ctx) => ctx.BodyForAgent)).toEqual(["human question", "abort"]);
    expect(contexts[0]?.MessageSid).toBe("human-question");
    expect(contexts.map((ctx) => ctx.BodyForAgent).join("\n")).not.toContain("Working");
  });

  it("keeps human text beginning with the progress label actionable", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;

    const monitor = monitorMattermostProvider({
      config: testConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "human-progress-looking-post",
      message: "| status?",
    });
    await monitor;

    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx.BodyForAgent).toBe(
      "| status?",
    );
  });

  it("does not recreate failed progress after observed message-tool delivery", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const draftStream = {
      update: vi.fn(),
      flush: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      retainTerminalText: vi.fn(async () => true),
      stop: vi.fn(async () => {}),
    };
    mockState.createMattermostDraftStream.mockReturnValue(draftStream);
    const progressConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: {
            mode: "progress",
            progress: {
              label: false,
              toolProgress: true,
              finalDelivery: "separate",
            },
          },
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(progressConfig);
    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      await params.replyOptions?.onToolStart?.({
        toolCallId: "read-1",
        name: "read",
        phase: "start",
      });
      params.replyOptions?.onAssistantMessageStart?.();
      params.replyOptions?.onReasoningEnd?.();
      await params.replyOptions?.onToolStart?.({
        toolCallId: "exec-1",
        name: "exec",
        phase: "start",
      });
      await params.replyOptions?.onItemEvent?.({
        itemId: "tool:read-1",
        kind: "tool",
        name: "read",
        status: "completed",
        progressText: "done",
      });
      await params.replyOptions?.onReasoningStream?.({ text: "Thinking" });
      await params.replyOptions?.onReasoningEnd?.();
      await params.replyOptions?.onReasoningStream?.({ text: "Checking" });
      await params.replyOptions?.onItemEvent?.({
        itemId: "tool:read-1",
        kind: "tool",
        name: "read",
        status: "completed",
        progressText: "done",
      });
      await params.replyOptions?.onObservedReplyDelivery?.();
      abortController.abort();
      throw new Error("late turn failure");
    });

    const monitor = monitorMattermostProvider({
      config: progressConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-progress",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "run this",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
    expect(replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(draftStream.retainTerminalText).not.toHaveBeenCalled();
    const updates = draftStream.update.mock.calls.map((call) => String(call[0]));
    expect(updates.at(-1)).toContain("Read");
    expect(updates.at(-1)).toContain("Exec");
    expect(updates.at(-1)).toContain("done");
    expect(updates.at(-1)).toContain("Checking");
    expect(updates.at(-1)).not.toContain("ThinkingChecking");
  });

  it("cleans up observed message-tool delivery when tool progress is disabled", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const draftStream = {
      update: vi.fn(),
      flush: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      retainTerminalText: vi.fn(async () => true),
      stop: vi.fn(async () => {}),
    };
    mockState.createMattermostDraftStream.mockReturnValue(draftStream);
    const progressConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: {
            mode: "progress",
            progress: {
              label: false,
              toolProgress: false,
              finalDelivery: "separate",
            },
          },
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(progressConfig);
    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      await params.replyOptions?.onReasoningStream?.({ text: "Checking" });
      await params.replyOptions?.onObservedReplyDelivery?.();
      abortController.abort();
      throw new Error("late turn failure");
    });

    const monitor = monitorMattermostProvider({
      config: progressConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-progress-without-tools",
      message: "reason, then send with the message tool",
    });
    socket.emitClose(1000);
    await monitor;

    const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
    expect(replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
    expect(replyOptions?.onObservedReplyDelivery).toBeTypeOf("function");
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(draftStream.retainTerminalText).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", { text: "" }],
    ["reasoning-only", { text: "Private reasoning", isReasoning: true }],
  ])("retains sanitized separate progress for a %s final", async (_label, finalPayload) => {
    const progressConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: {
            mode: "progress",
            progress: { finalDelivery: "separate" },
          },
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(progressConfig);
    const update = vi.fn();
    const flush = vi.fn(async () => {});
    const retainTerminalText = vi.fn(async () => true);
    const stop = vi.fn(async () => {});
    mockState.createMattermostDraftStream.mockReturnValue({
      update,
      updateAssistantText: vi.fn(),
      forceNewMessage: vi.fn(async () => {}),
      flush,
      postId: vi.fn(() => "progress-post-1"),
      clear: vi.fn(async () => {}),
      discardPending: vi.fn(async () => {}),
      retainTerminalText,
      seal: vi.fn(async () => {}),
      stop,
      settleBoundaries: vi.fn(async () => {}),
      resolveFinalText: (text: string) => ({ kind: "full" as const, text, publishedParts: [] }),
    });
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      await params.replyOptions?.onReasoningStream?.({ text: "Checking the workspace" });
      const dispatcherOptions =
        mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
      await dispatcherOptions?.deliver(finalPayload, { kind: "final" });
      abortController.abort();
    });

    const monitor = monitorMattermostProvider({
      config: progressConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });
    await vi.waitFor(() => expect(socket.openListenerCount).toBeGreaterThan(0));
    socket.emitOpen();
    await emitMattermostChannelPost(socket, {
      id: `post-${_label}-final`,
      message: "run this",
    });
    socket.emitClose(1000);
    await monitor;

    expect(update).toHaveBeenCalledWith(expect.stringContaining("Checking the workspace"));
    expect(flush).toHaveBeenCalled();
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      retainTerminalText.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(retainTerminalText).toHaveBeenCalledExactlyOnceWith("Working\n\nFailed.");
    expect(retainTerminalText.mock.invocationCallOrder[0]).toBeLessThan(
      stop.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
  });

  it.each([
    { label: "the final delivery throws", progressReceiptIncomplete: false },
    { label: "the progress flush loses its provider receipt", progressReceiptIncomplete: true },
  ])("marks failed separate progress when $label", async ({ progressReceiptIncomplete }) => {
    const progressConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: {
            mode: "progress",
            progress: { finalDelivery: "separate" },
          },
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(progressConfig);
    const retainTerminalText = vi.fn(async () => true);
    const discardPending = vi.fn(async () => {
      if (progressReceiptIncomplete) {
        throw createChannelPartialDeliveryError(new Error("progress receipt was unreadable"), {
          messageIds: [],
          visibleReplySent: true,
          content: "Working...",
        });
      }
    });
    mockState.createMattermostDraftStream.mockReturnValue({
      update: vi.fn(),
      updateAssistantText: vi.fn(),
      forceNewMessage: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      postId: vi.fn(() => (progressReceiptIncomplete ? undefined : "progress-post-1")),
      clear: vi.fn(async () => {}),
      discardPending,
      retainTerminalText,
      seal: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      settleBoundaries: vi.fn(async () => {}),
      resolveFinalText: (text: string) => ({ kind: "full" as const, text, publishedParts: [] }),
    });
    mockState.sendMessageMattermost.mockRejectedValueOnce(new Error("final send failed"));
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.dispatchInboundMessage.mockImplementation(async () => {
      try {
        const dispatcherOptions =
          mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
        await dispatcherOptions?.deliver({ text: "Final answer" }, { kind: "final" });
      } finally {
        abortController.abort();
      }
    });

    const monitor = monitorMattermostProvider({
      config: progressConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });
    await vi.waitFor(() => expect(socket.openListenerCount).toBeGreaterThan(0));
    socket.emitOpen();
    await emitMattermostChannelPost(socket, {
      id: `post-separate-final-failure-${progressReceiptIncomplete ? "partial" : "ordinary"}`,
      message: "run this",
    });
    socket.emitClose(1000);
    await monitor;

    expect(discardPending).toHaveBeenCalledOnce();
    expect(mockState.sendMessageMattermost).toHaveBeenCalledOnce();
    expect(retainTerminalText).toHaveBeenCalledExactlyOnceWith("Working\n\nFailed.");
  });

  it("attempts a separate final after the real progress stream loses its receipt", async () => {
    const progressConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: {
            mode: "progress",
            progress: { finalDelivery: "separate" },
          },
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(progressConfig);
    const actualDraftStream =
      await vi.importActual<typeof import("./draft-stream.js")>("./draft-stream.js");
    const requestPaths: string[] = [];
    const request: MattermostClient["request"] = async <T>(requestPath: string): Promise<T> => {
      requestPaths.push(requestPath);
      if (requestPath === "/posts") {
        return { message: "Working..." } as T;
      }
      return {} as T;
    };
    const client: MattermostClient = {
      baseUrl: "https://mattermost.example.com",
      apiBaseUrl: "https://mattermost.example.com/api/v4",
      token: "bot-token",
      request,
      fetchImpl: vi.fn(),
    };
    mockState.createMattermostClient.mockReturnValue(client);
    mockState.createMattermostDraftStream.mockImplementation((params) =>
      actualDraftStream.createMattermostDraftStream(params),
    );
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      try {
        await expect(
          params.replyOptions?.onReasoningStream?.({ text: "Checking the workspace" }),
        ).rejects.toThrow("did not include a post id");
        const dispatcherOptions =
          mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
        await expect(
          dispatcherOptions?.deliver({ text: "Final answer" }, { kind: "final" }),
        ).rejects.toThrow("did not include a post id");
      } finally {
        abortController.abort();
      }
    });

    const monitor = monitorMattermostProvider({
      config: progressConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });
    await vi.waitFor(() => expect(socket.openListenerCount).toBeGreaterThan(0));
    socket.emitOpen();
    await emitMattermostChannelPost(socket, {
      id: "post-separate-final-real-progress-partial",
      message: "run this",
    });
    socket.emitClose(1000);
    await monitor;

    expect(requestPaths).toEqual(["/posts"]);
    expect(mockState.sendMessageMattermost).toHaveBeenCalledOnce();
  });

  it("clears separate progress after a provider-accepted partial final", async () => {
    const progressConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: {
            mode: "progress",
            progress: { finalDelivery: "separate" },
          },
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(progressConfig);
    const clear = vi.fn(async () => {});
    const retainTerminalText = vi.fn(async () => true);
    mockState.createMattermostDraftStream.mockReturnValue({
      update: vi.fn(),
      updateAssistantText: vi.fn(),
      forceNewMessage: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      postId: vi.fn(() => "progress-post-1"),
      clear,
      discardPending: vi.fn(async () => {}),
      retainTerminalText,
      seal: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      settleBoundaries: vi.fn(async () => {}),
      resolveFinalText: (text: string) => ({ kind: "full" as const, text, publishedParts: [] }),
    });
    const finalReceipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "mattermost", messageId: "accepted-final-1", channelId: "chan-1" }],
      kind: "text",
    });
    mockState.sendMessageMattermost.mockRejectedValueOnce(
      createChannelPartialDeliveryError(new Error("post-send bookkeeping failed"), {
        messageIds: ["accepted-final-1"],
        receipt: finalReceipt,
        visibleReplySent: true,
        content: "Accepted final answer",
      }),
    );
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.dispatchInboundMessage.mockImplementation(async () => {
      try {
        const dispatcherOptions =
          mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
        await dispatcherOptions?.deliver({ text: "Accepted final answer" }, { kind: "final" });
      } finally {
        abortController.abort();
      }
    });

    const monitor = monitorMattermostProvider({
      config: progressConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });
    await vi.waitFor(() => expect(socket.openListenerCount).toBeGreaterThan(0));
    socket.emitOpen();
    await emitMattermostChannelPost(socket, {
      id: "post-provider-accepted-partial-final",
      message: "run this",
    });
    socket.emitClose(1000);
    await monitor;

    expect(clear).toHaveBeenCalledOnce();
    expect(retainTerminalText).not.toHaveBeenCalled();
  });

  it("retries terminal progress after a visible error final", async () => {
    const progressConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: {
            mode: "progress",
            progress: { finalDelivery: "separate" },
          },
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(progressConfig);
    const retainTerminalText = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("terminal edit failed"))
      .mockResolvedValueOnce(true);
    mockState.createMattermostDraftStream.mockReturnValue({
      update: vi.fn(),
      updateAssistantText: vi.fn(),
      forceNewMessage: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      postId: vi.fn(() => "progress-post-1"),
      clear: vi.fn(async () => {}),
      discardPending: vi.fn(async () => {}),
      retainTerminalText,
      seal: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      settleBoundaries: vi.fn(async () => {}),
      resolveFinalText: (text: string) => ({ kind: "full" as const, text, publishedParts: [] }),
    });
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "mattermost", messageId: "error-final-1", channelId: "chan-1" }],
      kind: "text",
    });
    mockState.sendMessageMattermost.mockResolvedValue({
      messageId: "error-final-1",
      channelId: "chan-1",
      receipt,
      content: "Public error summary",
    });
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.dispatchInboundMessage.mockImplementation(async () => {
      const dispatcherOptions =
        mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
      await dispatcherOptions?.deliver(
        { text: "Public error summary", isError: true },
        { kind: "final" },
      );
      abortController.abort();
    });

    const monitor = monitorMattermostProvider({
      config: progressConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });
    await vi.waitFor(() => expect(socket.openListenerCount).toBeGreaterThan(0));
    socket.emitOpen();
    await emitMattermostChannelPost(socket, {
      id: "post-error-final-status-retry",
      message: "run this",
    });
    socket.emitClose(1000);
    await monitor;

    expect(retainTerminalText).toHaveBeenCalledTimes(2);
    expect(mockState.sendMessageMattermost).toHaveBeenCalledTimes(1);
  });

  it("does not recreate failed progress after a successful final and later tool warning", async () => {
    const progressConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: {
            mode: "progress",
            progress: { finalDelivery: "separate" },
          },
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(progressConfig);
    const clear = vi.fn(async () => {});
    const retainTerminalText = vi.fn(async () => true);
    mockState.createMattermostDraftStream.mockReturnValue({
      update: vi.fn(),
      updateAssistantText: vi.fn(),
      forceNewMessage: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      postId: vi.fn(() => "progress-post-1"),
      clear,
      discardPending: vi.fn(async () => {}),
      retainTerminalText,
      seal: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      settleBoundaries: vi.fn(async () => {}),
      resolveFinalText: (text: string) => ({ kind: "full" as const, text, publishedParts: [] }),
    });
    const successReceipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "mattermost", messageId: "success-final-1", channelId: "chan-1" }],
      kind: "text",
    });
    const warningReceipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "mattermost", messageId: "tool-warning-1", channelId: "chan-1" }],
      kind: "text",
    });
    mockState.sendMessageMattermost
      .mockResolvedValueOnce({
        messageId: "success-final-1",
        channelId: "chan-1",
        receipt: successReceipt,
        content: "Successful assistant final",
      })
      .mockResolvedValueOnce({
        messageId: "tool-warning-1",
        channelId: "chan-1",
        receipt: warningReceipt,
        content: "Tool error warning",
      });
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.dispatchInboundMessage.mockImplementation(async () => {
      const dispatcherOptions =
        mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
      await dispatcherOptions?.deliver({ text: "Successful assistant final" }, { kind: "final" });
      await dispatcherOptions?.deliver(
        { text: "Tool error warning", isError: true },
        { kind: "final" },
      );
      abortController.abort();
    });

    const monitor = monitorMattermostProvider({
      config: progressConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });
    await vi.waitFor(() => expect(socket.openListenerCount).toBeGreaterThan(0));
    socket.emitOpen();
    await emitMattermostChannelPost(socket, {
      id: "post-success-final-late-warning",
      message: "run this",
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.sendMessageMattermost).toHaveBeenCalledTimes(2);
    expect(mockState.sendMessageMattermost.mock.calls.map((call) => call[1])).toEqual([
      "Successful assistant final",
      "Tool error warning",
    ]);
    expect(clear).toHaveBeenCalledOnce();
    expect(mockState.sendMessageMattermost.mock.invocationCallOrder[0]).toBeLessThan(
      clear.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(clear.mock.invocationCallOrder[0]).toBeLessThan(
      mockState.sendMessageMattermost.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
    expect(retainTerminalText).not.toHaveBeenCalled();
  });

  it("keeps separate progress and final delivery rootless in flat direct messages", async () => {
    const directConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "allowlist",
          groupPolicy: "open",
          allowFrom: ["user-1"],
          streaming: {
            mode: "progress",
            progress: { finalDelivery: "separate" },
          },
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(directConfig);
    mockState.resolveChannelInfo.mockResolvedValue({
      id: "chan-1",
      name: "",
      display_name: "",
      team_id: "team-1",
      type: "D",
    });
    mockState.createMattermostDraftStream.mockReturnValue({
      update: vi.fn(),
      updateAssistantText: vi.fn(),
      forceNewMessage: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      postId: vi.fn(() => "progress-post-1"),
      clear: vi.fn(async () => {}),
      discardPending: vi.fn(async () => {}),
      retainTerminalText: vi.fn(async () => true),
      seal: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      settleBoundaries: vi.fn(async () => {}),
      resolveFinalText: (text: string) => ({ kind: "full" as const, text, publishedParts: [] }),
    });
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "mattermost", messageId: "direct-final-1", channelId: "chan-1" }],
      kind: "text",
    });
    mockState.sendMessageMattermost.mockImplementation(async (_to, _text, options) => {
      options.onDmChannelResolution?.(Promise.resolve());
      return {
        messageId: "direct-final-1",
        channelId: "chan-1",
        receipt,
        content: "Final answer",
      };
    });
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      try {
        await params.replyOptions?.onReasoningStream?.({ text: "Checking" });
        const dispatcherOptions =
          mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
        await dispatcherOptions?.deliver({ text: "Final answer" }, { kind: "final" });
      } finally {
        abortController.abort();
      }
    });

    const monitor = monitorMattermostProvider({
      config: directConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });
    await vi.waitFor(() => expect(socket.openListenerCount).toBeGreaterThan(0));
    socket.emitOpen();
    await emitMattermostChannelPost(socket, {
      id: "post-flat-dm-separate",
      message: "run this",
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.createMattermostDraftStream).toHaveBeenCalledWith(
      expect.objectContaining({
        rootId: undefined,
        postType: "custom_openclaw_progress",
        cleanupMode: "strict",
      }),
    );
    expect(mockState.sendMessageMattermost).toHaveBeenCalledWith(
      expect.any(String),
      "Final answer",
      expect.objectContaining({ replyToId: undefined }),
    );
  });
});
