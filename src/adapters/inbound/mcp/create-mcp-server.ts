import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { CorrelationIdFactory } from '../../../application/ports/inspection-services.js';
import type { RequestCounters } from '../../../domain/stats/stats-policy.js';
import type {
  InspectSuccess,
  SourceReferenceInput,
} from '../../../domain/inspection/source-inspection.js';
import type { PrepareSuccess } from '../../../domain/preparation/preparation-types.js';
import type { PrepareRequest } from '../../../application/preparation/prepare-source.js';
import type {
  RetrieveRequestInput,
  RetrieveSuccess,
} from '../../../domain/retrieval/retrieval-types.js';
import type {
  VerifyRequestInput,
  VerifySuccess,
} from '../../../domain/verification/verification-policy.js';
import type { StatsSuccess } from '../../../application/stats/collect-session-stats.js';
import type {
  PurgePreviewSuccess,
  PurgeExecuteSuccess,
} from '../../../application/preparation/purge-derived-state.js';
import { SERVER_IDENTITY } from '../../../domain/server-identity.js';
import { registerInspectTool } from './inspect-tool.js';
import { registerPrepareTool } from './prepare-tool.js';
import { registerRetrieveTool } from './retrieve-tool.js';
import { registerVerifyTool } from './verify-tool.js';
import { registerStatsTool } from './stats-tool.js';
import { registerPurgeTool } from './purge-tool.js';

/**
 * The runtime instruction string is a client-facing boundary statement.
 * It stays honest about what the server returns: inspection and
 * preparation are raw-content-free, retrieval is content-revealing by
 * design and only available through an explicitly issued capability.
 */
export const SERVER_INSTRUCTIONS =
  'ContextVault exposes read-only source inspection, bounded structural preparation, target-bound purge of its own derived state, capability-gated exact retrieval, deterministic integrity verification, and exact process-scoped counters. Inspection and preparation are raw-content-free; retrieval returns exact excerpts only for sources with an explicitly issued retrieval grant and is content-revealing by design.';

export interface McpServerDependencies {
  readonly correlationIds: CorrelationIdFactory;
  readonly requestCounters: RequestCounters;
  readonly inspectSource: {
    readonly execute: (
      source: SourceReferenceInput,
      signal?: AbortSignal,
    ) => Promise<InspectSuccess>;
  };
  readonly prepareSource: {
    readonly execute: (request: PrepareRequest, signal?: AbortSignal) => Promise<PrepareSuccess>;
  };
  readonly retrieveSource: {
    readonly execute: (
      request: RetrieveRequestInput,
      signal?: AbortSignal,
    ) => Promise<RetrieveSuccess>;
  };
  readonly verifyEnvelope: {
    readonly execute: (request: VerifyRequestInput, signal?: AbortSignal) => Promise<VerifySuccess>;
  };
  readonly collectSessionStats: {
    readonly execute: () => StatsSuccess;
  };
  readonly purgeDerivedState: {
    readonly preview: (request: unknown) => PurgePreviewSuccess;
    readonly execute: (request: unknown) => PurgeExecuteSuccess;
  };
}

export function createMcpServer(dependencies: McpServerDependencies): McpServer {
  const server = new McpServer(SERVER_IDENTITY, {
    instructions: SERVER_INSTRUCTIONS,
  });

  const handlerDependencies = {
    correlationIds: dependencies.correlationIds,
    requestCounters: dependencies.requestCounters,
  };

  registerInspectTool(server, {
    inspectSource: dependencies.inspectSource,
    ...handlerDependencies,
  });
  registerPrepareTool(server, {
    prepareSource: dependencies.prepareSource,
    ...handlerDependencies,
  });
  registerRetrieveTool(server, {
    retrieveSource: dependencies.retrieveSource,
    ...handlerDependencies,
  });
  registerVerifyTool(server, {
    verifyEnvelope: dependencies.verifyEnvelope,
    ...handlerDependencies,
  });
  registerStatsTool(server, {
    collectSessionStats: dependencies.collectSessionStats,
    ...handlerDependencies,
  });
  registerPurgeTool(server, {
    purgeDerivedState: dependencies.purgeDerivedState,
    ...handlerDependencies,
  });

  return server;
}
