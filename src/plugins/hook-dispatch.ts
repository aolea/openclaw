import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { formatHookErrorForLog } from "../hooks/fire-and-forget.js";
import { formatErrorMessage } from "../infra/errors.js";
import { projectModelContextMessages } from "../shared/model-context-message.js";
import { readClaimingHookAdmission, type ClaimingHookAdmission } from "./hook-claim-admission.js";
import { cloneHookIsolationValue, HookIsolationError } from "./hook-isolation.js";
import type { HookRunnerRegistry } from "./hook-registry.types.js";
import type {
  HookFailurePolicy,
  HookRunnerOptions,
  VoidHookContextProjection,
  VoidHookRunOptions,
} from "./hook-runner-types.js";
import { withHookTimeout } from "./hook-timeout.js";
import { isPluginHookReplyDispatchKind } from "./hook-types.js";
import type {
  PluginHookAgentTrigger,
  PluginHookHandlerMap,
  PluginHookName,
  PluginHookRegistration,
  PluginHookToolResultPersistEvent,
} from "./hook-types.js";
import { runPluginCleanup } from "./plugin-instance-scope.js";
import { pluginToolMatcherCoversTool } from "./tool-hook-matcher.js";

const DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK: Partial<Record<PluginHookName, number>> = {
  agent_end: 30_000,
  channel_pairing_requested: 2_000,
  // Compaction hooks run on the serialized notification queue. Allow memory
  // flushes the agent_end budget, then fail open so later notifications proceed.
  before_compaction: 30_000,
  after_compaction: 30_000,
  skill_changed: 30_000,
  skill_proposal_changed: 30_000,
  // Shutdown hooks share the Gateway's five-second teardown budget. They fail
  // open after logging so one plugin cannot consume the process watchdog.
  gateway_stop: 5_000,
};
const DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK: Partial<Record<PluginHookName, number>> = {
  before_agent_run: 15_000,
  // Policy hooks fail closed in the global runner. A bounded timeout turns a
  // stalled policy process into a denial instead of freezing the operation.
  before_install: 15_000,
  before_tool_call: 15_000,
  // Terminal finalization hooks sit on the runner's completion path. A hung
  // handler must not freeze final delivery or keep compaction retry recovery
  // unresolved; timeout fail-opens with the original final answer.
  before_agent_finalize: 15_000,
  before_prompt_build: 15_000,
  // Outbound modifying hooks run inside the serialized reply delivery lane.
  // A hung plugin must fail open so later hooks and queued replies can settle.
  message_sending: 15_000,
  reply_payload_sending: 15_000,
  resolve_exec_env: 15_000,
  skill_proposal_evaluate: 120_000,
};

export function deepFreezeHookValue<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }
  // SAFETY: The preceding guard excludes null and primitives from this WeakSet traversal.
  const object = value as object;
  if (seen.has(object)) {
    return value;
  }
  seen.add(object);
  for (const child of Object.values(object)) {
    deepFreezeHookValue(child, seen);
  }
  return Object.freeze(value);
}

export type HookEvent<K extends PluginHookName> = Parameters<PluginHookHandlerMap[K]>[0];
export type HookContext<K extends PluginHookName> = Parameters<PluginHookHandlerMap[K]>[1];
export type HookResult<K extends PluginHookName> = Exclude<
  Awaited<ReturnType<PluginHookHandlerMap[K]>>,
  void
>;
export type ClaimingHookName = {
  [K in PluginHookName]: [HookResult<K>] extends [never]
    ? never
    : HookResult<K> extends { handled: boolean }
      ? K
      : never;
}[PluginHookName];

export type ModifyingHookPolicy<K extends PluginHookName> = {
  mergeResults?: (
    accumulated: HookResult<K> | undefined,
    next: HookResult<K>,
    registration: PluginHookRegistration<K>,
    event: HookEvent<K>,
  ) => HookResult<K>;
  isolateEventPerHandler?: boolean;
  eventForHandler?: (event: HookEvent<K>, result: HookResult<K> | undefined) => HookEvent<K>;
  mergeNullResults?: boolean;
  shouldStop?: (result: HookResult<K>) => boolean;
  terminalLabel?: string;
  includeRegistration?: (registration: PluginHookRegistration<K>) => boolean;
  assertHandlerBoundaryActive?: () => void;
  onHandlerResult?: (params: {
    hook: PluginHookRegistration<K>;
    result: HookResult<K> | undefined;
  }) => void;
  onHandlerError?: (hook: PluginHookRegistration<K>, failOpen: boolean) => void;
};

type SyncHookName = "tool_result_persist" | "before_message_write";
type SyncHookMessage = PluginHookToolResultPersistEvent["message"];
type SyncMessageHookStepResult = { message?: SyncHookMessage; block?: true };

export function isHookContextEligible(hook: PluginHookRegistration, ctx?: unknown): boolean {
  if (hook.hookName === "reply_dispatch" && hook.eligibleDispatchKinds !== undefined) {
    const kind =
      typeof ctx === "object" && ctx !== null && "dispatchKind" in ctx
        ? ctx.dispatchKind
        : undefined;
    // Unknown callers cannot prove exclusion from a hook, including during recovery checks.
    return !isPluginHookReplyDispatchKind(kind) || hook.eligibleDispatchKinds.includes(kind);
  }
  if (hook.hookName !== "before_agent_reply" || hook.eligibleTriggers === undefined) {
    return true;
  }
  const trigger =
    typeof ctx === "object" && ctx !== null && "trigger" in ctx
      ? (ctx as { trigger?: unknown }).trigger // SAFETY: Non-null object and property guards hold.
      : undefined;
  return (
    // SAFETY: The cast is only a membership query; non-enum strings cannot match the typed list.
    typeof trigger === "string" && hook.eligibleTriggers.includes(trigger as PluginHookAgentTrigger)
  );
}

/** Get hooks for a specific hook name, sorted by priority (higher first). */
export function getHooksForName<K extends PluginHookName>(
  registry: HookRunnerRegistry,
  hookName: K,
  ctx?: unknown,
  toolName?: string,
): PluginHookRegistration<K>[] {
  // SAFETY: Name filtering below selects only K registrations before any handler is invoked.
  return (registry.typedHooks as PluginHookRegistration<K>[])
    .filter((hook) => hook.hookName === hookName && isHookContextEligible(hook, ctx))
    .filter((hook) => toolName === undefined || pluginToolMatcherCoversTool(hook.matcher, toolName))
    .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

export const sanitizeHookError = (error: unknown): string => {
  const raw = formatErrorMessage(error);
  const firstLine = raw.split("\n")[0]?.trim();
  return firstLine || "unknown error";
};

export function createHookDispatch(registry: HookRunnerRegistry, options: HookRunnerOptions = {}) {
  const logger = options.logger;
  const catchErrors = options.catchErrors ?? true;
  const failurePolicyByHook = {
    before_agent_run: "fail-closed",
    ...options.failurePolicyByHook,
  } satisfies Partial<Record<PluginHookName, HookFailurePolicy>>;
  const voidHookTimeoutMsByHook = {
    ...DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK,
    ...options.voidHookTimeoutMsByHook,
  };
  const modifyingHookTimeoutMsByHook = {
    ...DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK,
    ...options.modifyingHookTimeoutMsByHook,
  };
  const shouldCatchHookErrors = (hookName: PluginHookName): boolean =>
    catchErrors && (failurePolicyByHook[hookName] ?? "fail-open") === "fail-open";

  const handleHookError = (params: {
    hookName: PluginHookName;
    pluginId: string;
    error: unknown;
  }): never | void => {
    const msg = `[hooks] ${params.hookName} handler from ${params.pluginId} failed: ${formatHookErrorForLog(params.error)}`;
    if (shouldCatchHookErrors(params.hookName)) {
      logger?.error(msg);
      return;
    }
    throw new Error(msg, { cause: params.error });
  };

  const awaitHook = <T>(
    hook: PluginHookRegistration,
    promise: Promise<T>,
    defaultTimeoutMs?: number,
    timeoutOptions?: { unref?: boolean },
  ): Promise<T> => {
    const timeoutMs =
      clampPositiveTimerTimeoutMs(hook.timeoutMs) ?? clampPositiveTimerTimeoutMs(defaultTimeoutMs);
    return timeoutMs ? withHookTimeout(promise, timeoutMs, timeoutOptions) : promise;
  };

  const runSyncMessageHookStep = <K extends SyncHookName>(
    hook: PluginHookRegistration<K>,
    hookName: K,
    event: HookEvent<K> & { message: SyncHookMessage },
    message: SyncHookMessage,
    ctx: HookContext<K>,
  ): SyncMessageHookStepResult | undefined => {
    try {
      // SAFETY: Both sync hooks share this message contract; promise-like returns are ignored below.
      const handler = hook.handler as (
        event: HookEvent<K>,
        ctx: HookContext<K>,
      ) => { message?: SyncHookMessage; block?: boolean } | PromiseLike<unknown> | void;
      const result = handler({ ...event, message }, ctx);
      if (isPromiseLike(result)) {
        // Sync-only hooks ignore async results; observe rejections so the global fatal handler cannot crash.
        void Promise.resolve(result).catch(() => undefined);
        const msg =
          `[hooks] ${hookName} handler from ${hook.pluginId} returned a Promise; ` +
          `this hook is synchronous and the result was ignored.`;
        if (!shouldCatchHookErrors(hookName)) {
          throw new Error(msg);
        }
        logger?.warn?.(msg);
        return undefined;
      }
      if (!result) {
        return undefined;
      }
      if (hookName === "before_message_write" && result.block) {
        return { block: true };
      }
      const nextMessage = result.message;
      return nextMessage ? { message: nextMessage } : undefined;
    } catch (err) {
      const msg = `[hooks] ${hookName} handler from ${hook.pluginId} failed: ${String(err)}`;
      if (shouldCatchHookErrors(hookName)) {
        logger?.error(msg);
        return undefined;
      }
      throw new Error(msg, { cause: err });
    }
  };

  const runSyncMessageHooks = <K extends SyncHookName>(
    hookName: K,
    event: HookEvent<K> & { message: SyncHookMessage },
    ctx: HookContext<K>,
  ): { message: SyncHookMessage; block?: true } | undefined => {
    const hooks = getHooksForName(registry, hookName);
    if (hooks.length === 0) {
      return undefined;
    }

    let current = event.message;
    for (const hook of hooks) {
      const result = runSyncMessageHookStep(hook, hookName, event, current, ctx);
      if (result?.block) {
        return { message: current, block: true };
      }
      if (result?.message) {
        current = result.message;
      }
    }
    return { message: current };
  };

  /**
   * All handlers are executed in parallel for performance.
   */
  async function runVoidHook<K extends PluginHookName>(
    hookName: K,
    event: HookEvent<K>,
    ctx: HookContext<K>,
    optionsValue: VoidHookRunOptions = {},
    matcherToolName?: string,
    projectContext?: VoidHookContextProjection<HookContext<K>, K>,
  ): Promise<void> {
    const hooks = getHooksForName(registry, hookName, undefined, matcherToolName);
    if (hooks.length === 0) {
      return;
    }

    logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers)`);

    const promises = hooks.map(async (hook) => {
      const projected = projectContext?.(hook, ctx);
      try {
        const invoke = () =>
          // SAFETY: Name-filtered K handlers receive K inputs; these void-hook callers ignore results.
          (hook.handler as (event: unknown, ctx: unknown) => Promise<void> | void)(
            event,
            projected?.context ?? ctx,
          );
        const handlerPromise = Promise.resolve(
          hookName === "gateway_stop" ? runPluginCleanup(hook.handler, invoke) : invoke(),
        );
        const promise = projected ? handlerPromise.finally(projected.dispose) : handlerPromise;
        await awaitHook(hook, promise, voidHookTimeoutMsByHook[hookName], {
          unref: optionsValue.unrefTimeout ?? true,
        });
      } catch (err) {
        handleHookError({ hookName, pluginId: hook.pluginId, error: err });
      } finally {
        projected?.dispose();
      }
    });

    // Strict lifecycle callers settle every handler's bounded outcome before advancing.
    const failures = (await Promise.allSettled(promises)).flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, failures.map(formatErrorMessage).join("; "));
    }
  }

  const bindVoidHook =
    <K extends PluginHookName>(hookName: K) =>
    (event: HookEvent<K>, ctx: HookContext<K>) =>
      runVoidHook(hookName, event, ctx);

  const bindModifyingHook =
    <K extends PluginHookName>(hookName: K, policy: ModifyingHookPolicy<K> = {}) =>
    (event: HookEvent<K>, ctx: HookContext<K>) =>
      runModifyingHook(hookName, event, ctx, policy);

  const bindClaimingHook =
    <K extends ClaimingHookName>(hookName: K) =>
    (event: HookEvent<K>, ctx: HookContext<K>) =>
      runClaimingHook<K, HookResult<K>>(hookName, event, ctx);

  const bindFrozenVoidHook =
    <K extends PluginHookName>(hookName: K) =>
    (event: HookEvent<K>, ctx: HookContext<K>) =>
      runVoidHook(hookName, deepFreezeHookValue(structuredClone(event)), ctx);

  /**
   * Handlers are executed sequentially in priority order, and results are merged.
   */
  async function runModifyingHook<K extends PluginHookName>(
    hookName: K,
    event: HookEvent<K>,
    ctx: HookContext<K>,
    policy: ModifyingHookPolicy<K> = {},
    matcherToolName?: string,
  ): Promise<HookResult<K> | undefined> {
    const hooks = getHooksForName(registry, hookName, undefined, matcherToolName);
    const selectedHooks = policy.includeRegistration
      ? hooks.filter(policy.includeRegistration)
      : hooks;
    if (selectedHooks.length === 0) {
      return undefined;
    }

    // Snapshot only after registration/authority filtering. Handlers in this dispatch
    // intentionally share its event, while later dispatches and the caller stay isolated.
    const dispatchEvent =
      (hookName === "before_prompt_build" || hookName === "agent_turn_prepare") &&
      "messages" in event &&
      Array.isArray(event.messages)
        ? cloneHookIsolationValue(hookName, {
            ...event,
            messages: projectModelContextMessages(event.messages),
          })
        : event;

    logger?.debug?.(`[hooks] running ${hookName} (${selectedHooks.length} handlers, sequential)`);

    let result: HookResult<K> | undefined;

    for (const hook of selectedHooks) {
      policy.assertHandlerBoundaryActive?.();
      readClaimingHookAdmission(ctx)?.assertCurrent?.();
      let shouldStop = false;
      try {
        // SAFETY: K-filtered handlers receive K inputs; sync/void results are normalized and checked below.
        const handler = hook.handler as (event: unknown, ctx: unknown) => Promise<HookResult<K>>;
        const handlerEvent = policy.eventForHandler
          ? policy.eventForHandler(dispatchEvent, result)
          : policy.isolateEventPerHandler
            ? cloneHookIsolationValue(hookName, dispatchEvent)
            : dispatchEvent;
        const invocation = hookName === "before_prompt_build" ? { active: true } : undefined;
        const handlerContext = invocation
          ? {
              ...ctx,
              hookInvocation: Object.freeze({
                assertActive() {
                  if (!invocation.active) {
                    throw new Error("prompt hook invocation is no longer active");
                  }
                },
              }),
            }
          : ctx;
        let handlerResult: HookResult<K> | undefined;
        try {
          const promise = Promise.resolve(handler(handlerEvent, handlerContext));
          handlerResult = await awaitHook(hook, promise, modifyingHookTimeoutMsByHook[hookName]);
        } finally {
          // Expiry closes this handler even while its work or a later handler continues.
          if (invocation) {
            invocation.active = false;
          }
        }

        policy.onHandlerResult?.({ hook, result: handlerResult });

        const shouldMergeResult =
          handlerResult !== undefined && (handlerResult !== null || policy.mergeNullResults);
        if (shouldMergeResult) {
          if (policy.mergeResults) {
            result = policy.mergeResults(result, handlerResult, hook, dispatchEvent);
          } else {
            result = handlerResult;
          }
          if (result && policy.shouldStop?.(result)) {
            const terminalLabel = policy.terminalLabel ? ` ${policy.terminalLabel}` : "";
            const priority = hook.priority ?? 0;
            logger?.debug?.(
              `[hooks] ${hookName}${terminalLabel} decided by ${hook.pluginId} (priority=${priority}); skipping remaining handlers`,
            );
            shouldStop = true;
          }
        }
      } catch (err) {
        const failOpen = !(err instanceof HookIsolationError) && shouldCatchHookErrors(hookName);
        policy.onHandlerError?.(hook, failOpen);
        if (err instanceof HookIsolationError) {
          throw err;
        }
        handleHookError({ hookName, pluginId: hook.pluginId, error: err });
      }
      policy.assertHandlerBoundaryActive?.();
      readClaimingHookAdmission(ctx)?.assertCurrent?.();
      if (shouldStop) {
        break;
      }
    }

    return result;
  }

  /**
   * Run a sequential claim hook where the first `{ handled: true }` result wins.
   */
  async function runClaimingHook<K extends PluginHookName, TResult extends { handled: boolean }>(
    hookName: K,
    event: HookEvent<K>,
    ctx: HookContext<K> & ClaimingHookAdmission,
    runHandler?: (run: () => Promise<TResult | void>) => Promise<TResult | void>,
  ): Promise<TResult | undefined> {
    const hooks = getHooksForName(registry, hookName, ctx);
    if (hooks.length === 0) {
      return undefined;
    }

    logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, first-claim wins)`);

    const outcome = await runClaimingHooksList(hooks, hookName, event, ctx, runHandler);
    return outcome.status === "handled" ? outcome.result : undefined;
  }

  async function runClaimingHooksList<
    K extends PluginHookName,
    TResult extends { handled: boolean },
  >(
    hooks: PluginHookRegistration<K>[],
    hookName: K,
    event: HookEvent<K>,
    ctx: HookContext<K> & ClaimingHookAdmission,
    runHandler?: (run: () => Promise<TResult | void>) => Promise<TResult | void>,
  ): Promise<
    | { status: "handled"; result: TResult }
    | { status: "declined" }
    | { status: "error"; error: string }
  > {
    const admission = readClaimingHookAdmission(ctx);
    let firstError: string | undefined;
    for (const hook of hooks) {
      // Host admission failures end dispatch; plugin fail-open policy cannot swallow them.
      if (admission?.prepare) {
        await admission.prepare();
      }
      admission?.assertCurrent?.();
      let handlerResult: TResult | void = undefined;
      try {
        const invokeHandler = async (): Promise<TResult | void> => {
          const promise = Promise.resolve(
            // SAFETY: Claim callers pair K with its handled-result type and supply matching K inputs.
            (hook.handler as (event: unknown, ctx: unknown) => Promise<TResult | void>)(event, ctx),
          );
          return await awaitHook(hook, promise);
        };
        handlerResult = runHandler ? await runHandler(invokeHandler) : await invokeHandler();
      } catch (err) {
        firstError ??= sanitizeHookError(err);
        handleHookError({ hookName, pluginId: hook.pluginId, error: err });
      }
      admission?.assertCurrent?.();
      if (handlerResult?.handled) {
        return { status: "handled", result: handlerResult };
      }
    }
    return firstError ? { status: "error", error: firstError } : { status: "declined" };
  }

  return {
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
  };
}
