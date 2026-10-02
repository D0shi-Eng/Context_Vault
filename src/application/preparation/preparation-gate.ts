import { ContextVaultError } from '../../domain/errors/context-vault-error.js';

/**
 * Counts active preparation operations and fails closed when the
 * configured concurrency limit is reached. There is no queueing: a
 * saturated gate rejects immediately with a retryable error so that no
 * operation can wait unbounded outside the caller's control.
 */
export class PreparationGate {
  readonly #limit: number;
  #active = 0;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ContextVaultError({
        code: 'CV_CONFIGURATION_INVALID',
        message: 'The preparation concurrency limit is invalid.',
      });
    }
    this.#limit = limit;
  }

  get activeCount(): number {
    return this.#active;
  }

  /** Acquires a slot or throws a retryable concurrency-limit error. */
  acquire(): void {
    if (this.#active >= this.#limit) {
      throw new ContextVaultError({
        code: 'CV_RESOURCE_CONCURRENCY_LIMIT',
        message: 'The maximum number of concurrent preparations was reached.',
        retryable: true,
      });
    }
    this.#active += 1;
  }

  release(): void {
    this.#active = Math.max(0, this.#active - 1);
  }
}
