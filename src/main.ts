#!/usr/bin/env node

import { runStdioServer } from './infrastructure/run-stdio-server.js';

try {
  await runStdioServer(process.versions.node, process.argv.slice(2));
} catch {
  process.stderr.write('ContextVault failed to start safely.\n');
  process.exitCode = 1;
}
