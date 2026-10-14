import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import type { ExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import { recordRuntimeActionDecision } from "../audit/runtime-action-decision.js";
import { finalizeGroupThreadToolReply } from "../auto-reply/group-thread-context.js";
import { formatHookErrorForLog } from "../hooks/fire-and-forget.js";
import {
  projectAgentEndEvent,
  withAgentRunId,
  withoutIncognitoLlmContent,
} from "./hook-agent-observations.js";
import {
  type GateHookResult,
  type InputGateDecision,
  isHookDecision,
} from "./hook-decision-types.js";
import {
  createHookDispatch,
  deepFreezeHookValue,
  getHooksForName,
  isHookContextEligible,
  sanitizeHookError,
  type HookContext,
  type HookEvent,
} from "./hook-dispatch.js";
import { cloneHookIsolationValue } from "./hook-isolation.js";
import type { GlobalHookRunnerRegistry, HookRunnerRegistry } from "./hook-registry.types.js";
import { acceptPluginReplyPayload, toPluginReplyPayload } from "./hook-reply-payload.js";
import {
  mergeAgentTurnPrepare,
  mergeBeforeAgentFinalize,
  mergeBeforeModelResolve,
  mergeBeforePromptBuild,
  stickyTrue,
} from "./hook-result-merge.js";
import type { HookRunnerOptions, VoidHookRunOptions } from "./hook-runner-types.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeDispatchContext,
  PluginHookBeforeDispatchEvent,
  PluginHookBeforeDispatchResult,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookInboundClaimResult,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookBeforeAgentRunEvent,
  PluginHookName,
  PluginHookRegistration,
  PluginHookSubagentDeliveryTargetResult,
  PluginHookToolContext,
  PluginHookToolResultPersistContext,
  PluginHookToolResultPersistEvent,
  PluginHookToolResultPersistResult,
  PluginHookToolAuthority,
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeMessageWriteResult,
  PluginHookResolveExecEnvContext,
  PluginHookResolveExecEnvEvent,
  PluginHookSkillContext,
  PluginHookSkillProposalEvaluateEvent,
  PluginHookSkillProposalEvaluationOutcome,
} from "./hook-types.js";
import { getPluginValueInstance } from "./plugin-instance-scope.js";
import {
  type PluginSubagentRequesterContext,
  withPluginSubagentRequesterContext,
} from "./runtime/subagent-requester-context.js";
import { projectSessionEndTranscriptContext } from "./session-end-transcript.js";
import { createPluginToolMatcherScope, type PluginToolMatcherScope } from "./tool-hook-matcher.js";

export type { VoidHookRunOptions } from "./hook-runner-types.js";

type PluginTargetedInboundClaimOutcome =
  | {
      status: "handled";
      result: PluginHookInboundClaimResult;
    }
  | {
      status: "missing_plugin";
    }
  | {
      status: "no_handler";
    }
  | {
      status: "declined";
    }
  | {
      status: "error";
      error: string;
    };

export function getToolHookMatcherScope(
  registry: HookRunnerRegistry,
  hookName: "before_tool_call" | "after_tool_call",
): PluginToolMatcherScope | undefined {
  return createPluginToolMatcherScope(
    getHooksForName(registry, hookName).map((registration) => registration.matcher),
  );
}

function getHooksForNameAndPlugin<K extends PluginHookName>(
  registry: HookRunnerRegistry,
  hookName: K,
  pluginId: string,
): PluginHookRegistration<K>[] {
  return getHooksForName(registry, hookName).filter((hook) => hook.pluginId === pluginId);
}

export function createHookRunner(
  registry: GlobalHookRunnerRegistry,
  options: HookRunnerOptions = {},
) {
  const logger = options.logger;
  const {
    awaitHook,
    modifyingHookTimeoutMsByHook,
    runSyncMessageHooks,
    runVoidHook,
    runModifyingHook,
    runClaimingHook,
    runClaimingHooksList,
    bindVoidHook,
    bindModifyingHook,
    bindClaimingHook,
    bindFrozenVoidHook,
  } = createHookDispatch(registry, options);
  // Prompt-build hooks may start nested agent runs through any caller. The
  // mutable token lets detached descendants dispatch after the outer run settles.
  const beforePromptBuildDispatch = new AsyncLocalStorage<{ active: boolean }>();
  const runtimeDecisionScopeId = randomUUID();
  let runtimeDecisionOrdinal = 0;

  const recordBeforeToolCallDecision = (params: {
    event: PluginHookBeforeToolCallEvent;
    hook: PluginHookRegistration<"before_tool_call">;
    token?: ExecutionIdentityAdmissionToken;
    result?: PluginHookBeforeToolCallResult;
    failOpen?: boolean;
    receiptAuthority?: () => boolean | void;
  }): void => {
    if (!params.receiptAuthority) {
      return;
    }
    try {
      if (params.receiptAuthority() === false) {
        return;
      }
    } catch {
      return;
    }
    const failed = params.failOpen !== undefined;
    const blocked = params.result?.block === true || params.failOpen === false;
    recordRuntimeActionDecision({
      token: params.token,
      family: "plugin",
      operation: "before_tool_call",
      outcome: blocked ? "denied" : params.failOpen ? "unknown" : "allowed",
      coverageState: blocked || !failed ? "enforced" : "unknown",
      reasonCode: failed
        ? params.failOpen
          ? "plugin_hook_failed_open"
          : "plugin_hook_failed_closed"
        : blocked
          ? "plugin_hook_blocked"
          : params.result?.requireApproval
            ? "plugin_hook_approval_required"
            : "plugin_hook_allowed",
      owner: "plugin-hook",
      decisionBoundary: "plugin.before-tool-call",
      policyRefs: ["plugin-hook:before-tool-call"],
      summary: failed
        ? params.failOpen
          ? "A plugin hook failed open, so its policy outcome is unknown."
          : "A plugin hook failed closed before tool execution."
        : blocked
          ? "A registered plugin hook denied tool execution."
          : params.result?.requireApproval
            ? "A registered plugin hook required a separate owner-native approval decision."
            : "A registered plugin hook allowed tool execution to continue.",
      missingEvidence: params.failOpen ? ["plugin.hook_decision"] : [],
      remediation: params.failOpen
        ? [
            {
              code: "repair_plugin_hook",
              text: "Inspect the registered plugin hook failure before relying on this action.",
            },
          ]
        : [],
      discriminator: JSON.stringify([
        params.hook.pluginId,
        params.hook.registrationId ?? null,
        params.event.toolCallId ?? null,
        ++runtimeDecisionOrdinal,
        params.event.toolName,
        runtimeDecisionScopeId,
      ]),
    });
  };

  async function runBeforePromptBuild(
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforePromptBuildResult | undefined> {
    if (beforePromptBuildDispatch.getStore()?.active) {
      return undefined;
    }
    const token = { active: true };
    return await beforePromptBuildDispatch.run(token, async () => {
      try {
        return await runModifyingHook("before_prompt_build", event, ctx, {
          mergeResults: mergeBeforePromptBuild,
          includeRegistration: (registration) => registration.requiresToolAuthority !== true,
        });
      } finally {
        token.active = false;
      }
    });
  }

  /** Runs context enrichment only after the host has finalized the turn's tool surface. */
  async function runAuthorizedPromptBuild(
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
    params: {
      toolAuthorityFingerprint: string;
      activeToolNames: readonly string[];
      assertHostActive: () => void;
    },
  ): Promise<PluginHookBeforePromptBuildResult | undefined> {
    const sourceFingerprint = params.toolAuthorityFingerprint.trim();
    if (!sourceFingerprint) {
      return undefined;
    }
    const activeToolNames = [
      ...new Set(params.activeToolNames.map(normalizeToolPolicyName).filter(Boolean)),
    ].toSorted();
    const activeToolNameSet = new Set(activeToolNames);
    const token = { active: true };
    const assertActive = () => {
      if (!token.active) {
        throw new Error("prompt tool authority is no longer active");
      }
      params.assertHostActive();
    };
    const authority: PluginHookToolAuthority = Object.freeze({
      fingerprint: createHash("sha256")
        .update(sourceFingerprint)
        .update("\0")
        .update(activeToolNames.join("\0"))
        .digest("hex"),
      allows(toolName: string): boolean {
        assertActive();
        return activeToolNameSet.has(normalizeToolPolicyName(toolName));
      },
      assertActive,
    });
    try {
      const result = await runModifyingHook(
        "before_prompt_build",
        event,
        { ...ctx, toolAuthority: authority },
        {
          mergeResults: mergeBeforePromptBuild,
          includeRegistration: (registration) => registration.requiresToolAuthority === true,
          assertHandlerBoundaryActive: assertActive,
        },
      );
      if (!result) {
        return undefined;
      }
      return {
        ...(result.prependContext ? { prependContext: result.prependContext } : {}),
        ...(result.appendContext ? { appendContext: result.appendContext } : {}),
      };
    } finally {
      token.active = false;
    }
  }

  async function runInboundClaimForPlugin(
    pluginId: string,
    event: PluginHookInboundClaimEvent,
    ctx: PluginHookInboundClaimContext,
  ): Promise<PluginHookInboundClaimResult | undefined> {
    const hooks = getHooksForNameAndPlugin(registry, "inbound_claim", pluginId);
    const outcome = await runClaimingHooksList<"inbound_claim", PluginHookInboundClaimResult>(
      hooks,
      "inbound_claim",
      event,
      ctx,
    );
    return outcome.status === "handled" ? outcome.result : undefined;
  }

  async function runInboundClaimForPluginOutcome(
    pluginId: string,
    event: PluginHookInboundClaimEvent,
    ctx: PluginHookInboundClaimContext,
  ): Promise<PluginTargetedInboundClaimOutcome> {
    const pluginOwner = registry.plugins.find(
      (plugin) =>
        plugin.id === pluginId &&
        plugin.status === "loaded" &&
        (ctx.pluginBinding?.requiredOwner !== true ||
          (plugin.rootDir ?? plugin.source) === ctx.pluginBinding.pluginRoot),
    );
    if (!pluginOwner) {
      return { status: "missing_plugin" };
    }
    const hooks = getHooksForNameAndPlugin(registry, "inbound_claim", pluginId);
    if (hooks.length === 0) {
      return { status: "no_handler" };
    }
    logger?.debug?.(
      `[hooks] running inbound_claim for ${pluginId} (${hooks.length} handlers, targeted outcome)`,
    );
    return runClaimingHooksList<"inbound_claim", PluginHookInboundClaimResult>(
      hooks,
      "inbound_claim",
      event,
      ctx,
      ctx.pluginBinding?.requiredOwner === true
        ? async (run) => {
            // The awaited durable route read above can cross plugin retirement/replacement.
            const currentOwner = registry.plugins.find(
              (plugin) =>
                plugin.id === pluginId &&
                plugin.status === "loaded" &&
                (plugin.rootDir ?? plugin.source) === ctx.pluginBinding?.pluginRoot,
            );
            const currentHooks = getHooksForNameAndPlugin(registry, "inbound_claim", pluginId);
            if (
              currentOwner !== pluginOwner ||
              hooks.some((hook) => !currentHooks.includes(hook))
            ) {
              throw new Error("Required conversation plugin owner changed during admission");
            }
            return await run();
          }
        : undefined,
    );
  }

  async function runBeforeDispatch(
    event: PluginHookBeforeDispatchEvent,
    ctx: PluginHookBeforeDispatchContext,
    requester?: PluginSubagentRequesterContext,
  ): Promise<PluginHookBeforeDispatchResult | undefined> {
    const runHandler = requester
      ? (run: () => Promise<PluginHookBeforeDispatchResult | void>) =>
          withPluginSubagentRequesterContext(requester, run)
      : undefined;
    return runClaimingHook<"before_dispatch", PluginHookBeforeDispatchResult>(
      "before_dispatch",
      event,
      ctx,
      runHandler,
    );
  }

  /** After session preparation, the first block wins; void handlers allow inference. */
  async function runBeforeAgentRun(
    event: PluginHookBeforeAgentRunEvent,
    ctx: PluginHookAgentContext,
  ): Promise<GateHookResult<InputGateDecision> | undefined> {
    let winningPluginId: string | undefined;
    const decision = await runModifyingHook("before_agent_run", event, ctx, {
      mergeResults: (_acc, next, reg) => {
        const normalized: InputGateDecision = isHookDecision(next)
          ? next
          : {
              outcome: "block",
              reason: "before_agent_run returned an invalid decision",
            };
        const merged =
          !_acc || (normalized.outcome === "block" && _acc.outcome !== "block") ? normalized : _acc;
        if (merged === normalized) {
          winningPluginId = reg.pluginId;
        }
        return merged;
      },
      mergeNullResults: true,
      shouldStop: (result) => result?.outcome === "block",
      terminalLabel: "gate-decision",
    });
    if (!decision) {
      return undefined;
    }
    return { decision, pluginId: winningPluginId ?? "unknown" };
  }

  async function runBeforeToolCall(
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
    receipt?: Readonly<{
      token: ExecutionIdentityAdmissionToken;
      assertAuthority: () => boolean | void;
      markOwnerDecision?: () => void;
    }>,
  ): Promise<PluginHookBeforeToolCallResult | undefined> {
    return runModifyingHook(
      "before_tool_call",
      event,
      ctx,
      {
        // A plugin may mutate its local event, but direct writes must not alter
        // the caller's params or the event observed by another plugin.
        isolateEventPerHandler: true,
        mergeResults: (acc, next, reg) => {
          if (acc?.block === true) {
            return acc;
          }
          const approvalAlreadyRequested = acc?.requireApproval !== undefined;
          let params = next.params ?? acc?.params;
          if (approvalAlreadyRequested) {
            params = acc?.params;
          } else if (next.requireApproval && params !== undefined) {
            // Approval covers one detached snapshot. Later hooks may still
            // block, but they cannot change what the operator reviewed.
            params = cloneHookIsolationValue("before_tool_call", params);
          }
          return {
            params,
            block: stickyTrue(acc?.block, next.block),
            blockReason: next.blockReason ?? acc?.blockReason,
            requireApproval:
              acc?.requireApproval ??
              (next.requireApproval
                ? { ...next.requireApproval, pluginId: reg.pluginId }
                : undefined),
          };
        },
        shouldStop: (result) => result.block === true,
        terminalLabel: "block=true",
        onHandlerResult: ({ hook, result }) => {
          receipt?.markOwnerDecision?.();
          recordBeforeToolCallDecision({
            event,
            hook,
            token: receipt?.token,
            result,
            receiptAuthority: receipt?.assertAuthority,
          });
        },
        onHandlerError: (hook, failOpen) => {
          receipt?.markOwnerDecision?.();
          recordBeforeToolCallDecision({
            event,
            hook,
            token: receipt?.token,
            failOpen,
            receiptAuthority: receipt?.assertAuthority,
          });
        },
      },
      event.toolName,
    );
  }

  /** Transcript hooks stay synchronous and pass each replacement to the next handler. */
  function runToolResultPersist(
    event: PluginHookToolResultPersistEvent,
    ctx: PluginHookToolResultPersistContext,
  ): PluginHookToolResultPersistResult | undefined {
    const result = runSyncMessageHooks("tool_result_persist", event, ctx);
    return result ? { message: result.message } : undefined;
  }

  /** A blocked transcript write stops the chain; otherwise publish only a changed message. */
  function runBeforeMessageWrite(
    event: PluginHookBeforeMessageWriteEvent,
    ctx: { agentId?: string; sessionKey?: string },
  ): PluginHookBeforeMessageWriteResult | undefined {
    const result = runSyncMessageHooks("before_message_write", event, ctx);
    if (result?.block) {
      return { block: true };
    }
    return result && result.message !== event.message ? { message: result.message } : undefined;
  }

  /**
   * Run every registered proposal evaluator and retain its attribution.
   *
   * Evaluator failures are returned as data so Workshop can persist and show
   * them. A broken optional evaluator must not make proposal state unreadable.
   */
  async function runSkillProposalEvaluate(
    event: PluginHookSkillProposalEvaluateEvent,
    ctx: PluginHookSkillContext,
  ): Promise<PluginHookSkillProposalEvaluationOutcome[]> {
    const hookName = "skill_proposal_evaluate";
    const hooks = getHooksForName(registry, hookName);
    if (hooks.length === 0) {
      return [];
    }

    logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, attributed)`);
    const immutableEvent = deepFreezeHookValue(structuredClone(event));
    return await Promise.all(
      hooks.map(async (hook): Promise<PluginHookSkillProposalEvaluationOutcome> => {
        const pluginVersion = registry.plugins.find(
          (plugin) => plugin.id === hook.pluginId,
        )?.packageVersion;
        const attribution = {
          evaluatorId: hook.registrationId ?? hook.pluginId,
          pluginId: hook.pluginId,
          ...(pluginVersion ? { pluginVersion } : {}),
        };
        try {
          const handler = hook.handler;
          const promise = Promise.resolve(handler(immutableEvent, ctx));
          const result = await awaitHook(hook, promise, modifyingHookTimeoutMsByHook[hookName]);
          return result
            ? Object.assign(attribution, { status: "completed" as const, result })
            : Object.assign(attribution, { status: "skipped" as const });
        } catch (error) {
          const message = sanitizeHookError(error);
          logger?.error(
            `[hooks] ${hookName} handler from ${hook.pluginId} failed: ${formatHookErrorForLog(error)}`,
          );
          return Object.assign(attribution, { status: "error" as const, error: message });
        }
      }),
    );
  }

  async function runResolveExecEnv(
    event: PluginHookResolveExecEnvEvent,
    ctx: PluginHookResolveExecEnvContext,
  ): Promise<Record<string, string>> {
    const result = await runModifyingHook("resolve_exec_env", event, ctx, {
      mergeResults: (acc, next) => (acc ? { ...acc, ...next } : next),
    });
    return result ?? {};
  }

  return {
    runBeforeModelResolve: bindModifyingHook("before_model_resolve", {
      mergeResults: mergeBeforeModelResolve,
    }),
    runAgentTurnPrepare: bindModifyingHook("agent_turn_prepare", {
      mergeResults: mergeAgentTurnPrepare,
    }),
    runBeforePromptBuild,
    runAuthorizedPromptBuild,
    hasAuthorizedPromptBuildHooks: (ctx?: Partial<HookContext<"before_prompt_build">>): boolean =>
      registry.typedHooks.some(
        (hook) =>
          hook.hookName === "before_prompt_build" &&
          hook.requiresToolAuthority === true &&
          (ctx === undefined || isHookContextEligible(hook, ctx)),
      ),
    runBeforeAgentReply: bindClaimingHook("before_agent_reply"),
    runModelCallStarted: bindVoidHook("model_call_started"),
    runModelCallEnded: bindVoidHook("model_call_ended"),
    runLlmInput: withoutIncognitoLlmContent(bindVoidHook("llm_input")),
    runLlmOutput: withoutIncognitoLlmContent(bindVoidHook("llm_output")),
    runBeforeAgentFinalize: async (
      event: HookEvent<"before_agent_finalize">,
      ctx: HookContext<"before_agent_finalize">,
    ) =>
      runModifyingHook("before_agent_finalize", withAgentRunId(event, ctx), ctx, {
        mergeResults: mergeBeforeAgentFinalize,
      }),
    runAgentEnd: async (
      event: HookEvent<"agent_end">,
      ctx: HookContext<"agent_end">,
      optionsLocal?: VoidHookRunOptions,
    ) => runVoidHook("agent_end", projectAgentEndEvent(event, ctx), ctx, optionsLocal),
    runBeforeCompaction: bindVoidHook("before_compaction"),
    runAfterCompaction: bindVoidHook("after_compaction"),
    runBeforeReset: bindVoidHook("before_reset"),
    runBeforeAgentRun,
    runInboundClaim: bindClaimingHook("inbound_claim"),
    runInboundClaimForPlugin,
    runInboundClaimForPluginOutcome,
    runChannelPairingRequested: bindVoidHook("channel_pairing_requested"),
    runMessageReceived: bindVoidHook("message_received"),
    runBeforeDispatch,
    runReplyDispatch: bindClaimingHook("reply_dispatch"),
    runReplyPayloadSending: bindModifyingHook("reply_payload_sending", {
      // Handlers see the latest payload without inheriting host-only media trust.
      eventForHandler: (event, result) => ({
        ...event,
        payload: toPluginReplyPayload(result?.payload ?? event.payload),
      }),
      mergeResults: (acc, next, _registration, event) => ({
        payload:
          next.payload === undefined
            ? (acc?.payload ?? event.payload)
            : acceptPluginReplyPayload(acc?.payload ?? event.payload, next.payload),
        cancel: stickyTrue(acc?.cancel, next.cancel),
        reason: next.reason ?? acc?.reason,
      }),
      shouldStop: (result) => result.cancel === true,
      terminalLabel: "cancel=true",
    }),
    runMessageSending: async (
      event: HookEvent<"message_sending">,
      ctx: HookContext<"message_sending">,
    ) => {
      const result = await runModifyingHook("message_sending", event, ctx, {
        mergeResults: (acc, next) => ({
          content: next.content ?? acc?.content,
          cancel: stickyTrue(acc?.cancel, next.cancel),
          cancelReason: next.cancelReason ?? acc?.cancelReason,
          metadata: next.metadata ?? acc?.metadata,
        }),
        shouldStop: (decision) => decision.cancel === true,
        terminalLabel: "cancel=true",
      });
      const original = result?.cancel ? undefined : (result?.content ?? event.content);
      const content = finalizeGroupThreadToolReply(original, event, ctx);
      return content !== original ? { ...result, content } : result;
    },
    runMessageSent: bindVoidHook("message_sent"),
    runBeforeToolCall,
    runAfterToolCall: async (
      event: HookEvent<"after_tool_call">,
      ctx: HookContext<"after_tool_call">,
    ) => runVoidHook("after_tool_call", event, ctx, {}, event.toolName),
    runToolResultPersist,
    runBeforeMessageWrite,
    runSessionStart: bindVoidHook("session_start"),
    runSessionEnd: (event: HookEvent<"session_end">, ctx: HookContext<"session_end">) =>
      runVoidHook("session_end", event, ctx, {}, undefined, (hook, context) =>
        projectSessionEndTranscriptContext(
          hook,
          context,
          getPluginValueInstance(hook.handler)?.lifecycle.signal,
        ),
      ),
    runSubagentDeliveryTarget: bindModifyingHook("subagent_delivery_target", {
      mergeResults: (acc, next): PluginHookSubagentDeliveryTargetResult =>
        acc?.origin ? acc : next,
    }),
    runSubagentSpawned: bindVoidHook("subagent_spawned"),
    runSubagentProgress: bindVoidHook("subagent_progress"),
    runSubagentEnded: bindVoidHook("subagent_ended"),
    runGatewayStart: bindVoidHook("gateway_start"),
    runGatewayStop: bindVoidHook("gateway_stop"),
    runHeartbeatPromptContribution: bindModifyingHook("heartbeat_prompt_contribution", {
      mergeResults: mergeAgentTurnPrepare,
    }),
    runCronReconciled: bindVoidHook("cron_reconciled"),
    runCronChanged: bindVoidHook("cron_changed"),
    runSkillProposalEvaluate,
    runSkillProposalChanged: bindFrozenVoidHook("skill_proposal_changed"),
    runSkillChanged: bindFrozenVoidHook("skill_changed"),
    runBeforeInstall: bindModifyingHook("before_install", {
      mergeResults: (acc, next) => {
        const findings = [...(acc?.findings ?? []), ...(next.findings ?? [])];
        return {
          findings: findings.length ? findings : undefined,
          block: stickyTrue(acc?.block, next.block),
          blockReason: next.blockReason ?? acc?.blockReason,
        };
      },
      shouldStop: (result) => result.block === true,
      terminalLabel: "block=true",
    }),
    runResolveExecEnv,
    hasHooks: <K extends PluginHookName>(hookName: K, ctx?: Partial<HookContext<K>>): boolean =>
      registry.typedHooks.some(
        (hook) =>
          hook.hookName === hookName && (ctx === undefined || isHookContextEligible(hook, ctx)),
      ),
    getHookCount: (hookName: PluginHookName): number =>
      registry.typedHooks.filter((h) => h.hookName === hookName).length,
  };
}

export type HookRunner = ReturnType<typeof createHookRunner>;

export type SubagentLifecycleHookRunner = Pick<
  HookRunner,
  "hasHooks" | "runSubagentSpawned" | "runSubagentProgress" | "runSubagentEnded"
>;
