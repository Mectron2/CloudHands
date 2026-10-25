import { loadConfig } from './config.js';
import { createHttpServer } from './http/server.js';
import { attachTerminal } from './auth/terminal.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const application = createHttpServer(config);

  await new Promise<void>((resolve, reject) => {
    application.server.once('error', reject);
    application.server.listen(config.port, config.host, resolve);
  });

  const address = application.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  let detachTerminal: (() => void) | undefined;
  try {
    detachTerminal = attachTerminal(application.auth);
  } catch (error) {
    await application.close();
    throw error;
  }
  console.log(`MCP server listening at http://${host}:${port}/mcp`);
  console.log(`OAuth MCP URL: ${application.auth.resource.href}`);
  console.log('Authentication: OAuth; approve new connections in this terminal');
  console.log(`Working directory: ${config.cwd}`);

  let stopping = false;
  const shutdown = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    detachTerminal?.();
    application.close().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
