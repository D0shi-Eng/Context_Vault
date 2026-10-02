import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createMcpServer } from '../adapters/inbound/mcp/create-mcp-server.js';
import { InspectSource } from '../application/inspection/inspect-source.js';
import { PreparationGate } from '../application/preparation/preparation-gate.js';
import { PrepareSource } from '../application/preparation/prepare-source.js';
import { PurgeDerivedState } from '../application/preparation/purge-derived-state.js';
import {
  runStartupSelfCheck,
  type StartupReport,
} from '../application/startup/run-startup-self-check.js';
import { RetrieveSource } from '../application/retrieval/retrieve-source.js';
import { VerifyEnvelope } from '../application/verification/verify-envelope.js';
import { CollectSessionStats } from '../application/stats/collect-session-stats.js';
import { parseStartupArguments } from './configuration/startup-arguments.js';
import { NodeCapabilityTokens } from './crypto/node-capability-tokens.js';
import { NodeInspectionCryptography } from './inspection/node-inspection-cryptography.js';
import { SystemInspectionClock } from './inspection/system-inspection-clock.js';
import { NodeOpaqueIdentifiers } from './preparation/node-opaque-identifiers.js';
import { InMemoryRequestCounters } from './vault/in-memory-request-counters.js';
import { InMemoryVault } from './vault/in-memory-vault.js';
import { NodeAuthorizedFileReader } from './workspace/node-authorized-file-reader.js';
import {
  STRICT_PREPARATION_LIMITS,
  validatePreparationLimits,
} from '../domain/preparation/preparation-limits.js';

export interface ContextVaultApplication {
  readonly server: McpServer;
  readonly startupReport: StartupReport;
  readonly workspaceRootCount: number;
}

export async function composeApplication(
  nodeVersion: string,
  arguments_: readonly string[] = [],
): Promise<ContextVaultApplication> {
  const startupReport = runStartupSelfCheck(nodeVersion);
  const startupArguments = parseStartupArguments(arguments_);
  const fileReader = await NodeAuthorizedFileReader.create(startupArguments.workspaceRoots);
  const cryptography = new NodeInspectionCryptography();
  const capabilityTokens = new NodeCapabilityTokens();
  const identifiers = new NodeOpaqueIdentifiers();
  const clock = new SystemInspectionClock();
  const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
  const vault = new InMemoryVault(identifiers.createSessionId(), limits);
  const requestCounters = new InMemoryRequestCounters();
  const inspectSource = new InspectSource({ clock, cryptography, fileReader });
  const prepareGate = new PreparationGate(limits.maxConcurrentPreparations);
  const prepareSource = new PrepareSource(
    {
      clock,
      cryptography,
      fileReader,
      vault,
      identifiers,
      limits,
      tokens: capabilityTokens,
      tokenDigester: capabilityTokens,
    },
    prepareGate,
  );
  const retrieveSource = new RetrieveSource({
    clock,
    cryptography,
    fileReader,
    vault,
    retrievalVault: vault,
    tokenDigester: capabilityTokens,
    digestComparator: capabilityTokens,
  });
  const verifyEnvelope = new VerifyEnvelope({
    clock,
    cryptography,
    fileReader,
    vault,
    retrievalVault: vault,
  });
  const collectSessionStats = new CollectSessionStats({
    clock,
    fileReader,
    vault,
    retrievalVault: vault,
    requestCounters,
  });
  const purgeDerivedState = new PurgeDerivedState({ clock, cryptography, identifiers, vault });
  const server = createMcpServer({
    correlationIds: cryptography,
    requestCounters,
    inspectSource,
    prepareSource,
    retrieveSource,
    verifyEnvelope,
    collectSessionStats,
    purgeDerivedState,
  });

  return Object.freeze({
    server,
    startupReport,
    workspaceRootCount: startupArguments.workspaceRoots.length,
  });
}
