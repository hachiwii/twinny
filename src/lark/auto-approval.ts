import { toErrorMessage } from "../errors.js";
import {
  DEFAULT_AUTO_APPROVAL_COMMENT,
  isAppAccessApprovalInstance,
  type LarkApprovalClient,
  type LarkApprovalTask
} from "./approval.js";
import type { LarkLogger } from "./types.js";

export interface LarkAutoApprovalWorkerOptions {
  approvalClient: LarkApprovalClient;
  appId: string;
  definitionCode: string;
  pollIntervalMs: number;
  logger?: LarkLogger;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export interface AutoApprovalRunStats {
  scanned: number;
  approved: number;
  skipped: number;
  failed: number;
}

export class LarkAutoApprovalWorker {
  private readonly approvalClient: LarkApprovalClient;
  private readonly appId: string;
  private readonly definitionCode: string;
  private readonly pollIntervalMs: number;
  private readonly logger?: LarkLogger;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private currentRun?: Promise<void>;
  private currentAbort?: AbortController;

  constructor(options: LarkAutoApprovalWorkerOptions) {
    this.approvalClient = options.approvalClient;
    this.appId = options.appId;
    this.definitionCode = options.definitionCode;
    this.pollIntervalMs = options.pollIntervalMs;
    this.logger = options.logger;
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.currentAbort?.abort();
    try {
      await this.currentRun;
    } catch {
      // Tick errors are already logged in tick().
    }
  }

  async runOnce(options: { signal?: AbortSignal } = {}): Promise<AutoApprovalRunStats> {
    const stats: AutoApprovalRunStats = { scanned: 0, approved: 0, skipped: 0, failed: 0 };
    const tasks = await this.approvalClient.listTodoTasks({
      signal: options.signal
    });

    for (const task of tasks) {
      stats.scanned += 1;
      try {
        const decision = await this.evaluateTask(task, options.signal);
        if (decision === "approved") {
          stats.approved += 1;
        } else {
          stats.skipped += 1;
        }
      } catch (error) {
        if (options.signal?.aborted) {
          throw error;
        }
        stats.failed += 1;
        this.logger?.warn?.(
          {
            error: toErrorMessage(error),
            taskId: task.taskId,
            instanceCode: task.instanceCode
          },
          "failed to process Lark approval task"
        );
      }
    }

    return stats;
  }

  private async evaluateTask(task: LarkApprovalTask, signal?: AbortSignal): Promise<"approved" | "skipped"> {
    if (task.supportApiOperate === false) {
      return "skipped";
    }

    const instance = await this.approvalClient.getInstance(task.instanceCode, { signal });
    if (!isAppAccessApprovalInstance(instance, { definitionCode: this.definitionCode, appId: this.appId })) {
      return "skipped";
    }

    await this.approvalClient.approveTask({
      instanceCode: task.instanceCode,
      taskId: task.taskId,
      comment: DEFAULT_AUTO_APPROVAL_COMMENT,
      signal
    });
    this.logger?.info?.(
      {
        taskId: task.taskId,
        instanceCode: task.instanceCode,
        appId: this.appId
      },
      "auto-approved Lark app access request"
    );
    return "approved";
  }

  private schedule(delayMs: number): void {
    if (!this.running) {
      return;
    }
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.currentAbort = new AbortController();
      const signal = this.currentAbort.signal;
      this.currentRun = this.runOnce({ signal })
        .then((stats) => {
          this.logger?.debug?.({ stats }, "completed Lark auto-approval poll");
        })
        .catch((error) => {
          if (!signal.aborted) {
            this.logger?.warn?.({ error: toErrorMessage(error) }, "Lark auto-approval poll failed");
          }
        })
        .finally(() => {
          this.currentAbort = undefined;
          this.currentRun = undefined;
          this.schedule(this.pollIntervalMs);
        });
    }, delayMs);
  }
}
