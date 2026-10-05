import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import {
  bindGenericCurrentConversation,
  updateCurrentConversationBindingRecord,
} from "../infra/outbound/current-conversation-bindings.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { initializeGlobalHookRunner, resetGlobalHookRunner } from "./hook-runner-global.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";
import { createLazyPluginRuntime } from "./loader-module-runtime.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import {
  createRequiredConversationRoutes,
  dispatchRequiredConversationIngress,
} from "./required-conversation-routes.js";
import { setActivePluginRegistry } from "./runtime.js";
import { createPluginRecord } from "./status.test-helpers.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const scope = {
  channel: "mattermost",
  accountId: "specialist",
  conversationId: "project-dev",
  threadId: "task-root",
};
const owner = { pluginId: "mission-plugin", pluginRoot: "test" };
const event = {
  channel: "mattermost",
  content: "@specialist perform action-1",
  messageId: "post-1",
  senderId: "coordinator",
  wasMentioned: true,
  isGroup: true,
};

describe("required native conversation ownership", () => {
  const dirs: string[] = [];
  let env: ReturnType<typeof captureEnv>;
  beforeEach(async () => {
    env = captureEnv(["OPENCLAW_STATE_DIR"]);
    await drainGlobalSingletonLifecycleState();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    setTestEnvValue("OPENCLAW_STATE_DIR", makeTrackedTempDir("required-native-route", dirs));
    resetGlobalHookRunner();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await drainGlobalSingletonLifecycleState();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    resetGlobalHookRunner();
    env.restore();
    cleanupTrackedTempDirs(dirs);
  });

  it("keeps protection through restart, missing owner, foreign root and disabled owner", async () => {
    const routes = createRequiredConversationRoutes(owner, () => {});
    const binding = await routes.protect({ ...scope, data: { actionId: "action-1" } });
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    expect(await routes.inspect(scope)).toMatchObject({
      bindingId: binding.bindingId,
      requiredOwner: true,
    });
    expect(await dispatchRequiredConversationIngress({ scope, event })).toMatchObject({
      status: "blocked",
    });
    const handler = vi.fn(async () => ({ handled: true, disposition: "accepted" }));
    const registry = createMockPluginRegistry([
      { pluginId: owner.pluginId, hookName: "inbound_claim", handler },
    ]);
    registry.plugins[0]!.rootDir = "foreign-root";
    initializeGlobalHookRunner(registry);
    expect(await dispatchRequiredConversationIngress({ scope, event })).toMatchObject({
      status: "blocked",
    });
    registry.plugins[0]!.rootDir = owner.pluginRoot;
    registry.plugins[0]!.status = "disabled";
    expect(await dispatchRequiredConversationIngress({ scope, event })).toMatchObject({
      status: "blocked",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires durable acceptance and delivers exact native identity without ordinary claiming hooks", async () => {
    await createRequiredConversationRoutes(owner, () => {}).protect({
      ...scope,
      data: { assignment: "a1", generation: 2 },
    });
    const unrelated = vi.fn(async () => ({ handled: true }));
    const handler = vi.fn(async () => ({ handled: true, disposition: "accepted" }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { pluginId: "unrelated", hookName: "inbound_claim", handler: unrelated, priority: 100 },
        { pluginId: owner.pluginId, hookName: "inbound_claim", handler },
      ]),
    );
    expect(await dispatchRequiredConversationIngress({ scope, event })).toMatchObject({
      status: "accepted",
    });
    expect(unrelated).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "post-1",
        senderId: "coordinator",
        conversationId: "project-dev",
        threadId: "task-root",
        accountId: "specialist",
      }),
      expect.objectContaining({
        pluginBinding: expect.objectContaining({
          requiredOwner: true,
          data: { assignment: "a1", generation: 2 },
        }),
      }),
    );
    handler.mockResolvedValueOnce({ handled: true, disposition: "retryable" });
    expect(await dispatchRequiredConversationIngress({ scope, event })).toMatchObject({
      status: "retryable",
    });
    handler.mockRejectedValueOnce(new Error("journal unavailable"));
    expect(await dispatchRequiredConversationIngress({ scope, event })).toMatchObject({
      status: "retryable",
    });
    handler.mockResolvedValueOnce({ handled: false, disposition: "accepted" });
    expect(await dispatchRequiredConversationIngress({ scope, event })).toMatchObject({
      status: "blocked",
      reason: "declined",
    });
  });

  it("guards the real reply entry over an older ordinary child binding before commands or model dispatch", async () => {
    const legacyConversation = {
      channel: scope.channel,
      accountId: scope.accountId,
      conversationId: scope.threadId,
      parentConversationId: scope.conversationId,
    };
    updateCurrentConversationBindingRecord(legacyConversation, () => ({
      bindingId: "ordinary-child",
      targetSessionKey: "agent:legacy:main",
      targetKind: "session",
      status: "active",
      boundAt: Date.now(),
      conversation: legacyConversation,
    }));
    await createRequiredConversationRoutes(owner, () => {}).protect({
      ...scope,
      threadId: undefined,
    });
    const deliver = vi.fn(async () => {});
    const replyResolver = vi.fn(async () => undefined);
    const dispatcher = createReplyDispatcher({ deliver });
    const request = {
      cfg: {},
      dispatcher,
      replyResolver,
      ctx: finalizeInboundContext({
        Body: "/new",
        Provider: "mattermost",
        Surface: "mattermost",
        NativeChannelId: scope.conversationId,
        AccountId: scope.accountId,
        MessageThreadId: scope.threadId,
        MessageSid: event.messageId,
        SenderId: event.senderId,
        ChatType: "group",
        CommandAuthorized: true,
      }),
    };
    try {
      await expect(dispatchReplyFromConfig(request)).rejects.toThrow(
        "Required conversation owner blocked",
      );
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            pluginId: owner.pluginId,
            hookName: "inbound_claim",
            handler: async () => ({ handled: true, disposition: "accepted" }),
          },
        ]),
      );
      expect(await dispatchReplyFromConfig(request)).toMatchObject({
        deliberateSilentTerminalReply: true,
      });
      expect(replyResolver).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      dispatcher.markComplete();
    }
  });

  it("scopes by account and thread, inherits room protection and rejects rebinding", async () => {
    const routes = createRequiredConversationRoutes(owner, () => {});
    await routes.protect(scope);
    expect(
      await dispatchRequiredConversationIngress({ scope: { ...scope, threadId: "other" }, event }),
    ).toEqual({ status: "unmanaged" });
    expect(
      await dispatchRequiredConversationIngress({ scope: { ...scope, accountId: "other" }, event }),
    ).toEqual({ status: "unmanaged" });
    await routes.protect({ ...scope, threadId: undefined });
    expect(
      await dispatchRequiredConversationIngress({ scope: { ...scope, threadId: "other" }, event }),
    ).toMatchObject({ status: "blocked" });
    await expect(routes.protect({ ...scope, targetSessionKey: "replacement" })).rejects.toThrow(
      "cannot be rebound",
    );
    await expect(
      createRequiredConversationRoutes(
        { pluginId: "foreign", pluginRoot: "test" },
        () => {},
      ).protect({ ...scope, threadId: "other" }),
    ).rejects.toThrow("another owner");
    await expect(
      createRequiredConversationRoutes(
        { pluginId: "foreign", pluginRoot: "test" },
        () => {},
      ).protect({ ...scope, accountId: "SPECIALIST", threadId: "another" }),
    ).rejects.toThrow("another owner");
    await expect(routes.protect({ ...scope, accountId: "!!!" })).rejects.toThrow(
      "explicit channel",
    );
  });

  it("rejects ordinary writer changes to required route semantics", async () => {
    const routes = createRequiredConversationRoutes(owner, () => {});
    const binding = await routes.protect({ ...scope, data: { assignment: "original" } });
    const ref = {
      channel: scope.channel,
      accountId: scope.accountId,
      conversationId: scope.threadId,
      parentConversationId: scope.conversationId,
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "mattermost",
          source: "test",
          plugin: {
            id: "mattermost",
            meta: { aliases: [] },
            conversationBindings: { supportsCurrentConversationBinding: true },
          },
        },
      ]),
    );
    await expect(
      bindGenericCurrentConversation({
        conversation: ref,
        targetKind: "session",
        targetSessionKey: `plugin:${owner.pluginId}:required:${binding.bindingId}`,
        metadata: { data: { assignment: "replacement" } },
      }),
    ).rejects.toThrow("cannot be replaced");
    for (const patch of [
      {
        metadata: {
          pluginBindingOwner: "plugin",
          ...owner,
          requiredOwner: true,
          data: { assignment: "replacement" },
        },
      },
      { boundAt: binding.boundAt + 1 },
      { targetKind: "subagent" as const },
      { status: "ended" as const },
    ]) {
      expect(() =>
        updateCurrentConversationBindingRecord(ref, (current) =>
          current ? { ...current, ...patch } : null,
        ),
      ).toThrow("cannot be replaced");
    }
    expect(await routes.inspect(scope)).toMatchObject({
      boundAt: binding.boundAt,
      data: { assignment: "original" },
    });
  });

  it("rejects writes after its host capability closes", async () => {
    let active = true;
    const routes = createRequiredConversationRoutes(owner, () => {
      if (!active) {
        throw new Error("closed");
      }
    });
    active = false;
    await expect(routes.protect(scope)).rejects.toThrow("closed");
    expect(await dispatchRequiredConversationIngress({ scope, event })).toEqual({
      status: "unmanaged",
    });
  });

  it("binds the public API to its registered plugin identity and revokes retained routes", async () => {
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {} },
      runtime: createLazyPluginRuntime({}),
    });
    const record = createPluginRecord({
      id: owner.pluginId,
      source: owner.pluginRoot,
      origin: "bundled",
    });
    const api = builder.createApi(record, { config: {} });
    builder.registry.plugins.push(record);
    markPluginRegistryActive(builder.registry);
    const retained = api.conversationRoutes;
    expect(await retained.protect(scope)).toMatchObject({
      pluginId: owner.pluginId,
      pluginRoot: owner.pluginRoot,
      requiredOwner: true,
    });
    markPluginRegistryRetired(builder.registry);
    await expect(retained.protect({ ...scope, threadId: "new" })).rejects.toThrow("not active");
    expect(await dispatchRequiredConversationIngress({ scope, event })).toMatchObject({
      status: "blocked",
    });
  });

  it("times out without releasing ownership and reconciles a late receipt on replay", async () => {
    await createRequiredConversationRoutes(owner, () => {}).protect(scope);
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const journal = new Set<string>();
    const handler = vi.fn(async () => {
      start();
      await pending;
      journal.add(event.messageId);
      return { handled: true, disposition: "accepted" };
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ pluginId: owner.pluginId, hookName: "inbound_claim", handler }]),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = dispatchRequiredConversationIngress({ scope, event });
    await started;
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await first).toMatchObject({ status: "retryable" });
    finish();
    await pending;
    vi.useRealTimers();
    expect(await dispatchRequiredConversationIngress({ scope, event })).toMatchObject({
      status: "accepted",
    });
    expect(journal.size).toBe(1);
  });
});
