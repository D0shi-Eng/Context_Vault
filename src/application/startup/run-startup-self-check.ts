import { MINIMUM_NODE_MAJOR, SERVER_IDENTITY } from '../../domain/server-identity.js';
import { parseNodeMajorVersion } from '../../domain/runtime-version.js';

export interface StartupReport {
  readonly serverName: string;
  readonly serverVersion: string;
  readonly nodeMajor: number;
  readonly transport: 'stdio';
  readonly networkListeners: 0;
}

export function runStartupSelfCheck(nodeVersion: string): StartupReport {
  const nodeMajor = parseNodeMajorVersion(nodeVersion);

  if (nodeMajor === undefined || nodeMajor < MINIMUM_NODE_MAJOR) {
    throw new Error('Unsupported Node.js runtime.');
  }

  return Object.freeze({
    serverName: SERVER_IDENTITY.name,
    serverVersion: SERVER_IDENTITY.version,
    nodeMajor,
    transport: 'stdio',
    networkListeners: 0,
  });
}
