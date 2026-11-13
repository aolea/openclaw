import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  resolveReplyCompletionPolicyFromPolicies,
  type ReplyCompletionConversationType,
  type ReplyCompletionPolicy,
} from "../shared/reply-completion-policy.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Resolves which confirmed source actions may complete a routed conversation turn. */
export function resolveReplyCompletionSettings(params: {
  cfg?: OpenClawConfig;
  surface?: string;
  conversationType: ReplyCompletionConversationType;
}): {
  policy: ReplyCompletionPolicy;
} {
  const normalizedSurface = normalizeLowercaseStringOrEmpty(params.surface);
  const surface = normalizedSurface ? params.cfg?.surfaces?.[normalizedSurface] : undefined;
  return {
    policy: resolveReplyCompletionPolicyFromPolicies({
      conversationType: params.conversationType,
      defaultPolicy: params.cfg?.agents?.defaults?.replyCompletion,
      surfacePolicy: surface?.replyCompletion,
    }),
  };
}
