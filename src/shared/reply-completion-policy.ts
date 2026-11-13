export type ReplyCompletionPolicy = "message" | "message-or-reaction";
export type ReplyCompletionConversationType = "direct" | "group" | "internal";
export type ReplyCompletionPolicyShape = {
  group?: ReplyCompletionPolicy;
};

export function resolveReplyCompletionPolicyFromPolicies(params: {
  conversationType: ReplyCompletionConversationType;
  defaultPolicy?: ReplyCompletionPolicyShape;
  surfacePolicy?: ReplyCompletionPolicyShape;
}): ReplyCompletionPolicy {
  if (params.conversationType !== "group") {
    return "message";
  }
  return params.surfacePolicy?.group ?? params.defaultPolicy?.group ?? "message";
}
