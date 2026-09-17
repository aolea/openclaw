// Gateway cron contracts stay separate from the runtime so shared request
// types do not pull scheduler implementation dependencies into their graph.
import type { CronJobScratchState, CronJobScratchWriteResult } from "../cron/scratch-store.js";
import type { CronServiceContract } from "../cron/service-contract.js";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake-contracts.js";

export type GatewayCronServiceContract = CronServiceContract & {
  /** Durable operator wakes bind one ticket to the exact model-run lifecycle. */
  wakeWithLifecycle(
    opts: { mode: "now" | "next-heartbeat"; text: string; sessionKey: string; agentId: string },
    lifecycle: { onAgentRunStart: (runId: string) => void },
  ):
    | { ok: true; completion: Promise<HeartbeatRunResult> }
    | { ok: false; reason: "wake-lifecycle-unavailable" };
  /** Cancel exact current definitions under the serving scheduler's operation lock. */
  quiesceJobs(
    jobs: readonly { id: string; revision: string }[],
    commitGuard: () => void,
  ): Promise<void>;
  /** Remove an owned declarative job family from obsolete SQLite store partitions. */
  removeStaleJobFamily(
    family: { declarationKey: string; name: string; ownerPluginTag: string },
    opts?: { commitGuard?: () => void },
  ): Promise<number>;
  readScratch(id: string): Promise<CronJobScratchState>;
  writeScratch(
    id: string,
    params: {
      content: string | null;
      expectedRevision?: number;
      sourceSha256?: string;
      commitGuard?: () => void;
    },
  ): Promise<CronJobScratchWriteResult>;
  /** Serialize agent-job removal with the roster commit and restore on failure. */
  removeAgentJobsTransactional<T>(agentId: string, commit: () => Promise<T>): Promise<T>;
  /** Temporarily disarm ticks without running startup recovery on resume. */
  pauseScheduling(): void;
  resumeScheduling(): void;
  /** Scheduler-owned work not represented by active cron run markers. */
  getSuspensionBlockerCount?(): number;
  /** Materialize lazy cron dependencies before a synchronous operator wake. */
  prepareWake?(): Promise<void>;
  /** Stop cron and await scheduler-owned child process teardown. */
  stopAndDrain?(): Promise<void>;
};
