/**
 * Pure types and formulas for the exact process-scoped operation counters.
 *
 * Every counter is precisely defined below and covered by tests. The
 * counters are process-scoped and reset on restart; they never contain
 * content, paths, raw tokens, or queries.
 *
 * Formulas:
 * - activeEnvelopeCount        = number of envelope records currently stored
 *                                (after expired envelopes are swept).
 * - activeGrantCount           = number of unrevoked, unexpired grant records.
 * - authorizedRootCount        = number of workspace roots authorized at
 *                                process startup (fixed after startup).
 * - serializedDerivedRecordBytes = sum of the serialized byte counts the
 *                                server computed for its own derived
 *                                records. This is a bookkeeping figure for
 *                                derived records only; it is not the
 *                                process heap usage.
 * - successfulRequests         = tool calls that returned a non-error result.
 * - failedRequests             = tool calls that returned an error result
 *                                or failed validation.
 * - envelopesRemovedByExpiry   = envelopes removed by TTL sweeps.
 * - envelopesRemovedByPurge    = envelopes removed by explicit purge.
 * - grantsRevoked              = grants revoked by expiry, purge, or sweep.
 * - purgeIntentsConsumed       = purge intents consumed by successful executes.
 */

export interface SessionCounters {
  readonly activeEnvelopeCount: number;
  readonly activeGrantCount: number;
  readonly authorizedRootCount: number;
  readonly serializedDerivedRecordBytes: number;
  readonly provenanceRecordsRetained: number;
  readonly successfulRequests: number;
  readonly failedRequests: number;
  readonly envelopesRemovedByExpiry: number;
  readonly envelopesRemovedByPurge: number;
  readonly grantsRevoked: number;
  readonly purgeIntentsConsumed: number;
}

export interface RequestCounterSnapshot {
  readonly successful: number;
  readonly failed: number;
}

export interface RequestCounters {
  recordSuccess(): void;
  recordFailure(): void;
  snapshot(): RequestCounterSnapshot;
}
