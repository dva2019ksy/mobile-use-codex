import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ControlTransport } from './control-transport.mjs';

const require = createRequire(import.meta.url);
const { createMcpServer } = require('@mobilenext/mobile-mcp/lib/server.js');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handle = serveStdio(() => createMcpServer(), {
    transport: new ControlTransport(),
    onerror: (error) => console.error(error),
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await handle.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.on('end', shutdown);
}
