import type { HeartbeatRunResult } from "./heartbeat-wake-contracts.js";

export type HeartbeatWakeSettlement = {
  active: boolean;
  tracksStart: boolean;
  started: boolean;
  start: (runId: string) => void;
  settle: (result: HeartbeatRunResult) => void;
};

export function activeHeartbeatWakeSettlements(
  ...groups: Array<readonly HeartbeatWakeSettlement[] | undefined>
): HeartbeatWakeSettlement[] {
  return groups.flatMap((group) => group ?? []).filter((settlement) => settlement.active);
}

export function settleHeartbeatWakeSettlements(
  settlements: readonly HeartbeatWakeSettlement[] | undefined,
  result: HeartbeatRunResult,
) {
  for (const settlement of settlements ?? []) {
    settlement.settle(result);
  }
}

function startHeartbeatWakeSettlements(
  settlements: readonly HeartbeatWakeSettlement[] | undefined,
  runId: string,
) {
  for (const settlement of settlements ?? []) {
    settlement.start(runId);
  }
}

export function resolveHeartbeatWakeStartCallback(
  settlements: readonly HeartbeatWakeSettlement[] | undefined,
): ((runId: string) => void) | undefined {
  return settlements?.some((settlement) => settlement.tracksStart)
    ? (runId) => startHeartbeatWakeSettlements(settlements, runId)
    : undefined;
}

function createHeartbeatWakeSettlement(lifecycle?: {
  abortSignal?: AbortSignal;
  onAgentRunStart?: (runId: string) => void;
}): {
  result: Promise<HeartbeatRunResult>;
  settlement: HeartbeatWakeSettlement;
} {
  const control: {
    resolve?: (result: HeartbeatRunResult) => void;
    removeAbortListener?: () => void;
  } = {};
  const result = new Promise<HeartbeatRunResult>((resolve) => {
    control.resolve = resolve;
  });
  const settlement: HeartbeatWakeSettlement = {
    active: true,
    tracksStart: lifecycle?.onAgentRunStart !== undefined,
    started: false,
    start: (runId) => {
      if (!settlement.active || settlement.started) {
        return;
      }
      lifecycle?.onAgentRunStart?.(runId);
      settlement.started = true;
    },
    settle: (outcome) => {
      if (!settlement.active) {
        return;
      }
      settlement.active = false;
      control.removeAbortListener?.();
      control.resolve?.(outcome);
    },
  };
  const onAbort = () => settlement.settle({ status: "failed", reason: "heartbeat wake cancelled" });
  control.removeAbortListener = () => lifecycle?.abortSignal?.removeEventListener("abort", onAbort);
  if (lifecycle?.abortSignal?.aborted) {
    onAbort();
  } else {
    lifecycle?.abortSignal?.addEventListener("abort", onAbort, { once: true });
  }
  return { result, settlement };
}

export function createRequestHeartbeatAndWait<Request>(
  enqueue: (request: Request, settlements?: HeartbeatWakeSettlement[]) => void,
) {
  return (
    request: Request,
    lifecycle?: { abortSignal?: AbortSignal; onAgentRunStart?: (runId: string) => void },
  ) => {
    const pending = createHeartbeatWakeSettlement(lifecycle);
    if (pending.settlement.active) {
      enqueue(request, [pending.settlement]);
    }
    return pending.result;
  };
}
