import { readCurrentConversationBindingSelectionAsync } from "../infra/outbound/current-conversation-bindings.js";
import { buildBindingId } from "../infra/outbound/current-conversation-bindings.kernel.js";
import type {
  ConversationRef,
  SessionBindingRecord,
} from "../infra/outbound/session-binding.types.js";
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { toPluginConversationBinding } from "./conversation-binding.js";
import type {
  PluginRequiredConversationRouteScope,
  PluginRequiredConversationRoutes,
} from "./conversation-binding.types.js";
import { withClaimingHookAdmission } from "./hook-claim-admission.js";
import type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
} from "./hook-message.types.js";
import { getGlobalHookRunner } from "./hook-runner-global.js";
import { withHookTimeout } from "./hook-timeout.js";

function conversation(scope: PluginRequiredConversationRouteScope): ConversationRef {
  const channel = scope.channel.trim().toLowerCase();
  const accountId = normalizeOptionalAccountId(scope.accountId);
  const room = scope.conversationId.trim();
  const thread = scope.threadId?.trim();
  if (!channel || !accountId || !room || (scope.threadId !== undefined && !thread)) {
    throw new Error("Required route needs explicit channel, account and conversation identity");
  }
  return {
    channel,
    accountId,
    conversationId: thread ?? room,
    ...(thread ? { parentConversationId: room } : {}),
  };
}

/** Reads committed protections even when the owning plugin or channel is unavailable. */
async function inspectRequiredRoute(scope: PluginRequiredConversationRouteScope) {
  const exact = conversation(scope);
  const refs = [exact];
  if (exact.parentConversationId) {
    refs.push({
      channel: exact.channel,
      accountId: exact.accountId,
      conversationId: exact.parentConversationId,
    });
  }
  const rows = await readCurrentConversationBindingSelectionAsync(refs);
  return rows.find((row) => row?.metadata?.requiredOwner === true) ?? null;
}

/** Only the registry supplies identity and live authority; plugins cannot choose either. */
export function createRequiredConversationRoutes(
  identity: {
    pluginId: string;
    pluginName?: string;
    pluginRoot: string;
  },
  assertCurrent: () => void,
): PluginRequiredConversationRoutes {
  return {
    async protect(params) {
      assertCurrent();
      const ref = conversation(params);
      const record: SessionBindingRecord = {
        bindingId: buildBindingId(ref),
        targetKind: "session",
        status: "active",
        boundAt: Date.now(),
        conversation: ref,
        targetSessionKey:
          params.targetSessionKey?.trim() ||
          `plugin:${identity.pluginId}:required:${buildBindingId(ref)}`,
        metadata: {
          pluginBindingOwner: "plugin",
          ...identity,
          requiredOwner: true,
          ...(params.data ? { data: structuredClone(params.data) } : {}),
        },
      };
      const context = captureOpenClawStateWorkerContext();
      const protectedRecord = await runOpenClawStateWorkerOperation(
        context,
        (worker) => worker.execute({ type: "conversationBindings.protect", input: record }),
        {
          assertCurrent,
          createAdmission: createSqliteWorkerWriteAdmission(() => {
            context.admission.assertCurrent();
            assertCurrent();
          }, [context.admission.databasePath]),
        },
      );
      assertCurrent();
      const binding = toPluginConversationBinding(protectedRecord);
      if (!binding) {
        throw new Error("Required route did not retain its owner");
      }
      return binding;
    },
    async inspect(scope) {
      assertCurrent();
      const binding = toPluginConversationBinding(await inspectRequiredRoute(scope));
      assertCurrent();
      return binding?.pluginId === identity.pluginId && binding.pluginRoot === identity.pluginRoot
        ? binding
        : null;
    },
  };
}

export type RequiredConversationIngressResult =
  | { status: "unmanaged" }
  | { status: "accepted"; bindingId: string }
  | { status: "blocked" | "retryable"; bindingId: string; reason: string };

/** Native connectors call this before activation, batching, commands or ordinary model dispatch. */
export async function dispatchRequiredConversationIngress(params: {
  scope: PluginRequiredConversationRouteScope;
  event: PluginHookInboundClaimEvent;
  context?: Pick<PluginHookInboundClaimContext, "agentId" | "sessionKey">;
}): Promise<RequiredConversationIngressResult> {
  const record = await inspectRequiredRoute(params.scope);
  if (!record) {
    return { status: "unmanaged" };
  }
  const binding = toPluginConversationBinding(record);
  if (!binding) {
    throw new Error("Required route has invalid owner metadata");
  }
  const runner = getGlobalHookRunner();
  if (!runner) {
    return { status: "blocked", bindingId: binding.bindingId, reason: "owner_unavailable" };
  }
  const assertCurrent = async () => {
    const current = await inspectRequiredRoute(params.scope);
    if (
      !current ||
      current.bindingId !== record.bindingId ||
      current.boundAt !== record.boundAt ||
      current.metadata?.pluginId !== binding.pluginId ||
      current.metadata?.pluginRoot !== binding.pluginRoot
    ) {
      throw new Error("Required route owner changed during intake");
    }
  };
  try {
    const outcome = await withHookTimeout(
      runner.runInboundClaimForPluginOutcome(
        binding.pluginId,
        {
          ...params.event,
          channel: params.scope.channel,
          accountId: params.scope.accountId,
          conversationId: params.scope.conversationId,
          threadId: params.scope.threadId,
        },
        withClaimingHookAdmission(
          {
            ...params.context,
            channelId: params.scope.channel,
            accountId: params.scope.accountId,
            conversationId: params.scope.conversationId,
            parentConversationId: params.scope.threadId ? params.scope.conversationId : undefined,
            messageId: params.event.messageId,
            senderId: params.event.senderId,
            pluginBinding: { ...binding, threadId: params.scope.threadId },
          },
          assertCurrent,
        ),
      ),
      10_000,
    );
    if (outcome.status === "handled") {
      const disposition = outcome.result.disposition;
      return disposition === "accepted"
        ? { status: "accepted", bindingId: binding.bindingId }
        : {
            status: disposition === "blocked" ? "blocked" : "retryable",
            bindingId: binding.bindingId,
            reason: disposition ?? "custody_not_confirmed",
          };
    }
    return {
      status: outcome.status === "error" ? "retryable" : "blocked",
      bindingId: binding.bindingId,
      reason: outcome.status,
    };
  } catch {
    return { status: "retryable", bindingId: binding.bindingId, reason: "owner_failed" };
  }
}
