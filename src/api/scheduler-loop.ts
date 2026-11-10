import { SidebandError } from "../core/errors.js";

export interface SchedulerLoopStatus {
  readonly state: "stopped" | "running" | "degraded";
  readonly lastPassAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastErrorCode: string | null;
  readonly consecutiveFailures: number;
  readonly lastProcessed: number;
}

export interface SchedulerLoopOptions {
  /** One bounded batch of due work; resolves to the number of occurrences processed. */
  readonly runBatch: (limit: number) => Promise<number>;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  /** Upper bound of batches drained in one pass, so a backlog cannot starve the event loop. */
  readonly maxBatchesPerPass?: number;
  readonly now?: () => Date;
  /** Receives only a structured code, never schedule bodies or host payloads. */
  readonly onError?: (code: string) => void;
}

/**
 * Single-flight timer that drives due schedule work. Passes never overlap, failures back off
 * without stopping the loop, and stop() waits for an in-flight pass before resolving.
 */
export class SchedulerLoop {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = true;
  /** Set only by stop(), so a manual runOnce() on a never-started loop still drains work. */
  private halting = false;
  private lastPassAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastErrorCode: string | null = null;
  private consecutiveFailures = 0;
  private lastProcessed = 0;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxBatches: number;
  private readonly now: () => Date;

  constructor(private readonly options: SchedulerLoopOptions) {
    this.intervalMs = options.intervalMs ?? 1_000;
    this.batchSize = options.batchSize ?? 25;
    this.maxBatches = options.maxBatchesPerPass ?? 4;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.halting = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.halting = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  /** Runs one pass now unless one is already running. */
  runOnce(): Promise<void> {
    this.inFlight ??= this.pass().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  status(): SchedulerLoopStatus {
    return {
      state: this.stopped ? "stopped" : this.consecutiveFailures > 0 ? "degraded" : "running",
      lastPassAt: this.lastPassAt,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorCode: this.lastErrorCode,
      consecutiveFailures: this.consecutiveFailures,
      lastProcessed: this.lastProcessed,
    };
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce().finally(() => {
        const backoff = Math.min(this.intervalMs * 2 ** this.consecutiveFailures, 30_000);
        this.schedule(this.consecutiveFailures > 0 ? backoff : this.intervalMs);
      });
    }, delayMs);
    this.timer.unref();
  }

  private async pass(): Promise<void> {
    this.lastPassAt = this.now().toISOString();
    let processed = 0;
    try {
      for (let batch = 0; batch < this.maxBatches && !this.halting; batch += 1) {
        const count = await this.options.runBatch(this.batchSize);
        processed += count;
        if (count < this.batchSize) break;
      }
      this.lastProcessed = processed;
      this.lastSuccessAt = this.now().toISOString();
      this.lastErrorCode = null;
      this.consecutiveFailures = 0;
    } catch (error) {
      this.lastProcessed = processed;
      this.consecutiveFailures += 1;
      this.lastErrorCode = error instanceof SidebandError ? error.code : "SCHEDULER_PASS_FAILED";
      this.options.onError?.(this.lastErrorCode);
    }
  }
}
