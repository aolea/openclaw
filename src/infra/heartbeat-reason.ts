// Heartbeat wake reasons are displayed/logged, so normalize blanks to a stable
// default before they reach scheduling or diagnostics.
import type { HeartbeatWakeIntent, HeartbeatWakeSource } from "./heartbeat-wake-contracts.js";

const REASON_PRIORITY = {
  RETRY: 0,
  INTERVAL: 1,
  DEFAULT: 2,
  ACTION: 3,
} as const;

/** Normalize a heartbeat wake reason for logs and UI. */
export function normalizeHeartbeatWakeReason(reason?: string): string {
  return reason?.trim() || "requested";
}

export function resolveHeartbeatWakePriority(params: {
  source: HeartbeatWakeSource;
  intent: HeartbeatWakeIntent;
  reason: string;
}): number {
  if (params.intent === "manual" || params.intent === "immediate") {
    return REASON_PRIORITY.ACTION;
  }
  if (params.source === "retry" || params.reason === "retry") {
    return REASON_PRIORITY.RETRY;
  }
  if (
    params.intent === "scheduled" ||
    params.source === "interval" ||
    params.reason === "interval"
  ) {
    return REASON_PRIORITY.INTERVAL;
  }
  return REASON_PRIORITY.DEFAULT;
}
