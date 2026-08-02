/**
 * Rate limit accounting (spec: github-data-sync, task 4.6).
 *
 * The tracker watches the quota headers every response carries and refuses to start further
 * non-urgent work once the remaining quota falls below a safety threshold — the job is deferred
 * until the reset, with its progress already recorded, rather than being allowed to fail
 * mid-repository.
 */
import { RetryableError } from '../jobs/errors';
import type { RateLimitSnapshot } from './http';

export class RateLimitTracker {
  private snapshot: RateLimitSnapshot | undefined;

  constructor(private readonly safetyThreshold: number) {}

  observe = (snapshot: RateLimitSnapshot): void => {
    this.snapshot = snapshot;
  };

  get remaining(): number | undefined {
    return this.snapshot?.remaining;
  }

  get resetAt(): Date | undefined {
    return this.snapshot?.resetAt;
  }

  /** True when there is not enough quota left to safely continue optional work. */
  isBelowThreshold(): boolean {
    return this.snapshot?.remaining !== undefined && this.snapshot.remaining < this.safetyThreshold;
  }

  secondsUntilReset(now: Date = new Date()): number {
    if (!this.snapshot?.resetAt) return 60;
    return Math.max(1, Math.ceil((this.snapshot.resetAt.getTime() - now.getTime()) / 1000));
  }

  /**
   * Called between units of work. Throws a retryable error carrying the reset time, which the
   * worker turns into a scheduled retry.
   */
  assertHeadroom(context: string): void {
    if (!this.isBelowThreshold()) return;
    throw new RetryableError(
      `Pausing ${context}: ${this.remaining} GitHub API points remain, below the ` +
        `${this.safetyThreshold} safety threshold`,
      this.secondsUntilReset(),
    );
  }
}
