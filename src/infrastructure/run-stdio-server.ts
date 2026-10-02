import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { composeApplication } from './composition-root.js';

export async function runStdioServer(
  nodeVersion: string,
  arguments_: readonly string[],
): Promise<void> {
  const application = await composeApplication(nodeVersion, arguments_);
  const transport = new StdioServerTransport();
  await application.server.connect(transport);
}
