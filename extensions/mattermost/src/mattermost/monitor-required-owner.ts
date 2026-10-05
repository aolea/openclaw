import { dispatchRequiredConversationIngress } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { matchesMattermostBotMention } from "./monitor-helpers.js";
import type { MattermostIngressPost } from "./monitor-ingress.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";

/** Retains original post identity before native debounce, self filters, or mention activation. */
export async function dispatchMattermostRequiredOwner(
  monitor: MattermostMonitorContext,
  post: MattermostIngressPost,
  payload: MattermostEventPayload,
): Promise<boolean> {
  const channelId =
    normalizeOptionalString(post.channel_id) ??
    normalizeOptionalString(payload.data?.channel_id) ??
    normalizeOptionalString(payload.broadcast?.channel_id);
  if (!channelId || !post.id || !post.user_id) {
    throw new Error("Managed intake lacks source identity");
  }
  const result = await dispatchRequiredConversationIngress({
    scope: {
      channel: "mattermost",
      accountId: monitor.account.accountId,
      conversationId: channelId,
      threadId: normalizeOptionalString(post.root_id),
    },
    event: {
      channel: "mattermost",
      content: post.message ?? "",
      body: post.message ?? "",
      messageId: post.id,
      senderId: post.user_id,
      timestamp: post.create_at ?? undefined,
      isGroup: true,
      wasMentioned: matchesMattermostBotMention(post.message ?? "", monitor.botUsername),
      senderUsername: normalizeOptionalString(payload.data?.sender_name),
      providerUpdate: {
        id: post.id,
        kind: "posted",
        messageId: post.id,
        messageTimestamp: post.create_at ?? undefined,
      },
      metadata: {
        updateAt: post.update_at || post.create_at,
        nativeChannelId: channelId,
        nativeBotUserId: monitor.botUserId,
        self: post.user_id === monitor.botUserId,
        postType: post.type ?? "",
        props: post.props ?? {},
        fileIds: post.file_ids ?? [],
      },
    },
  });
  if (result.status === "unmanaged") {
    return false;
  }
  if (result.status !== "accepted") {
    // Throw leaves custody in the durable native ingress queue; it never completes dedup.
    throw new Error(`Required conversation owner ${result.status}: ${result.reason}`);
  }
  return true;
}
