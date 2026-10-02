import type { AuthorizedFileReader } from '../ports/authorized-file-reader.js';
import type { InspectionClock } from '../ports/inspection-services.js';
import type { PreparationVault } from '../ports/preparation-services.js';
import type { RetrievalVault } from '../ports/retrieval-services.js';
import type { RequestCounters, SessionCounters } from '../../domain/stats/stats-policy.js';

export interface CollectSessionStatsDependencies {
  readonly clock: InspectionClock;
  readonly fileReader: AuthorizedFileReader;
  readonly vault: PreparationVault;
  readonly retrievalVault: RetrievalVault;
  readonly requestCounters: RequestCounters;
}

export interface StatsSuccess {
  readonly schemaVersion: '1.0';
  readonly ok: true;
  readonly counters: SessionCounters;
  readonly measuredAt: string;
}

/**
 * Collects the exact, process-scoped operational counters.
 *
 * Formulas (each also asserted by tests):
 * - activeEnvelopeCount: envelope records stored after the TTL sweep.
 * - activeGrantCount: unrevoked, unexpired grants at the same instant.
 * - authorizedRootCount: roots authorized at process startup.
 * - serializedDerivedRecordBytes: the server's own serialized derived
 *   record bookkeeping total. This is not process heap usage.
 * - provenanceRecordsRetained: bounded provenance records in the ring.
 * - successfulRequests / failedRequests: tool-call outcomes.
 * - envelopesRemovedByExpiry / envelopesRemovedByPurge: lifetime sweeps
 *   and explicit purges.
 * - grantsRevoked: grants removed by expiry, sweep, or purge.
 * - purgeIntentsConsumed: one-time purge intents consumed successfully.
 *
 * Counters never contain content, paths, raw tokens, or queries.
 */
export class CollectSessionStats {
  readonly #clock: InspectionClock;
  readonly #fileReader: AuthorizedFileReader;
  readonly #vault: PreparationVault;
  readonly #retrievalVault: RetrievalVault;
  readonly #requestCounters: RequestCounters;

  constructor(dependencies: CollectSessionStatsDependencies) {
    this.#clock = dependencies.clock;
    this.#fileReader = dependencies.fileReader;
    this.#vault = dependencies.vault;
    this.#retrievalVault = dependencies.retrievalVault;
    this.#requestCounters = dependencies.requestCounters;
  }

  execute(): StatsSuccess {
    const now = this.#clock.now();
    this.#vault.sweepExpired(now);

    const requests = this.#requestCounters.snapshot();
    const lifecycle = this.#vault.lifecycleCounters();

    let provenanceRecordsRetained = 0;
    for (const envelope of this.#vault.list()) {
      provenanceRecordsRetained += this.#retrievalVault.listProvenanceForEnvelope(
        envelope.envelopeId,
      ).length;
    }

    return Object.freeze({
      schemaVersion: '1.0' as const,
      ok: true as const,
      counters: Object.freeze({
        activeEnvelopeCount: this.#vault.snapshot().envelopeCount,
        activeGrantCount: this.#retrievalVault.countActiveGrants(now),
        authorizedRootCount: this.#fileReader.authorizedRootCount,
        serializedDerivedRecordBytes: this.#vault.snapshot().totalDerivedBytes,
        provenanceRecordsRetained,
        successfulRequests: requests.successful,
        failedRequests: requests.failed,
        envelopesRemovedByExpiry: lifecycle.envelopesRemovedByExpiry,
        envelopesRemovedByPurge: lifecycle.envelopesRemovedByPurge,
        grantsRevoked: lifecycle.grantsRevoked,
        purgeIntentsConsumed: lifecycle.purgeIntentsConsumed,
      }),
      measuredAt: now.toISOString(),
    });
  }
}
