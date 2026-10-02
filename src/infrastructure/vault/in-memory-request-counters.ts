import type { RequestCounterSnapshot, RequestCounters } from '../../domain/stats/stats-policy.js';

/**
 * In-memory, process-scoped request outcome counters.
 *
 * A tool call counts as successful exactly when its handler returned a
 * non-error result, and as failed exactly when it returned an error
 * result or failed transport validation. Counters reset on restart.
 */
export class InMemoryRequestCounters implements RequestCounters {
  #successful = 0;
  #failed = 0;

  recordSuccess(): void {
    this.#successful += 1;
  }

  recordFailure(): void {
    this.#failed += 1;
  }

  snapshot(): RequestCounterSnapshot {
    return Object.freeze({
      successful: this.#successful,
      failed: this.#failed,
    });
  }
}
