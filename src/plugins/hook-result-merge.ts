import { createToolPolicyMatcher } from "../agents/tool-policy-match.js";
import {
  attachToolAllowlistIntersection,
  expandToolGroups,
  normalizeToolList,
  readToolAllowlistIntersection,
} from "../agents/tool-policy.js";
import { concatOptionalTextSegments } from "../shared/text/join-segments.js";
import type {
  BeforeAgentFinalizeResultWithRetryCandidates,
  BeforeAgentFinalizeRetry,
} from "./hook-runner-types.js";
import type {
  PluginAgentTurnPrepareResult,
  PluginHookBeforeAgentFinalizeResult,
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildResult,
} from "./hook-types.js";

export const stickyTrue = (prev?: boolean, next?: boolean): true | undefined =>
  prev === true || next === true ? true : undefined;
export const mergeBeforeModelResolve = (
  acc: PluginHookBeforeModelResolveResult | undefined,
  next: PluginHookBeforeModelResolveResult,
): PluginHookBeforeModelResolveResult => ({
  // Keep the first defined override so higher-priority hooks win.
  modelOverride: acc?.modelOverride ?? next.modelOverride,
  providerOverride: acc?.providerOverride ?? next.providerOverride,
});

const normalizeHookToolsAllow = (value: unknown): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
};

const readHookToolsAllowRestrictions = (value: unknown): string[][] => {
  const normalized = normalizeHookToolsAllow(value);
  if (normalized === undefined) {
    return [];
  }
  const attached = Array.isArray(value) ? readToolAllowlistIntersection(value) : undefined;
  return attached
    ? attached.map((restriction) => normalizeHookToolsAllow(restriction) ?? [])
    : [normalized];
};

const intersectToolsAllow = (left: string[] | undefined, right: string[]): string[] => {
  if (left === undefined) {
    return right;
  }
  if (left.length === 0 || right.length === 0) {
    return [];
  }
  const normalizedLeft = normalizeToolList(expandToolGroups(left));
  const normalizedRight = normalizeToolList(expandToolGroups(right));
  if (normalizedLeft.includes("*")) {
    return normalizedRight;
  }
  if (normalizedRight.includes("*")) {
    return normalizedLeft;
  }
  const matchesLeft = createToolPolicyMatcher({ allow: normalizedLeft });
  const matchesRight = createToolPolicyMatcher({ allow: normalizedRight });
  return [...new Set(normalizeToolList([...normalizedLeft, ...normalizedRight]))].filter(
    (name) => matchesLeft(name) && matchesRight(name),
  );
};

export const mergeBeforePromptBuild = (
  acc: PluginHookBeforePromptBuildResult | undefined,
  next: PluginHookBeforePromptBuildResult,
): PluginHookBeforePromptBuildResult => {
  const toolRestrictions = [
    ...readHookToolsAllowRestrictions(acc?.toolsAllow),
    ...readHookToolsAllowRestrictions(next.toolsAllow),
  ];
  const toolsAllow =
    toolRestrictions.length === 0
      ? undefined
      : attachToolAllowlistIntersection(
          [
            ...(toolRestrictions.reduce<string[] | undefined>(intersectToolsAllow, undefined) ??
              []),
          ],
          toolRestrictions,
        );
  return {
    // Keep the first defined system prompt so higher-priority hooks win.
    systemPrompt: acc?.systemPrompt ?? next.systemPrompt,
    ...mergeAgentTurnPrepare(acc, next),
    ...(toolsAllow !== undefined ? { toolsAllow } : {}),
    prependSystemContext: concatOptionalTextSegments({
      left: acc?.prependSystemContext,
      right: next.prependSystemContext,
    }),
    appendSystemContext: concatOptionalTextSegments({
      left: acc?.appendSystemContext,
      right: next.appendSystemContext,
    }),
  };
};

export const mergeAgentTurnPrepare = (
  acc: PluginAgentTurnPrepareResult | undefined,
  next: PluginAgentTurnPrepareResult,
): PluginAgentTurnPrepareResult => ({
  prependContext: concatOptionalTextSegments({
    left: acc?.prependContext,
    right: next.prependContext,
  }),
  appendContext: concatOptionalTextSegments({
    left: acc?.appendContext,
    right: next.appendContext,
  }),
});

export const mergeBeforeAgentFinalize = (
  acc: PluginHookBeforeAgentFinalizeResult | undefined,
  next: PluginHookBeforeAgentFinalizeResult,
): PluginHookBeforeAgentFinalizeResult => {
  const normalizeRetry = (
    retry: PluginHookBeforeAgentFinalizeResult["retry"] | undefined,
  ): BeforeAgentFinalizeRetry | undefined => {
    const instruction = typeof retry?.instruction === "string" ? retry.instruction.trim() : "";
    if (!instruction) {
      return undefined;
    }
    return {
      ...retry,
      instruction,
    };
  };
  const readRetryCandidates = (
    result: PluginHookBeforeAgentFinalizeResult | undefined,
  ): BeforeAgentFinalizeRetry[] => {
    if (!result || result.action !== "revise") {
      return [];
    }
    // SAFETY: This merger adds optional retryCandidates; arrays and instructions are checked below.
    const candidateList = (result as BeforeAgentFinalizeResultWithRetryCandidates).retryCandidates;
    if (Array.isArray(candidateList) && candidateList.length > 0) {
      return candidateList
        .map(normalizeRetry)
        .filter((retry): retry is BeforeAgentFinalizeRetry => retry !== undefined);
    }
    const retry = normalizeRetry(result.retry);
    return retry ? [retry] : [];
  };
  if (acc?.action === "finalize") {
    return acc;
  }
  if (next.action === "finalize") {
    return { action: "finalize", reason: next.reason };
  }
  if (acc?.action === "revise" && next.action === "revise") {
    const retryCandidates = [...readRetryCandidates(acc), ...readRetryCandidates(next)];
    const retry = retryCandidates[0];
    const result: PluginHookBeforeAgentFinalizeResult = {
      action: "revise",
      reason: concatOptionalTextSegments({ left: acc.reason, right: next.reason }),
      ...(retry ? { retry } : {}),
    };
    if (retryCandidates.length > 1) {
      Object.defineProperty(result, "retryCandidates", {
        configurable: true,
        enumerable: false,
        value: retryCandidates,
      });
    }
    return result;
  }
  if (acc?.action === "revise") {
    return acc;
  }
  if (next.action === "revise") {
    const retry = normalizeRetry(next.retry);
    return {
      action: "revise",
      reason: next.reason,
      ...(retry ? { retry } : {}),
    };
  }
  return next.action === "continue" ? { action: "continue", reason: next.reason } : (acc ?? next);
};
