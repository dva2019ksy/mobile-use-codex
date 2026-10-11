import { createServer } from 'node:http';
import { readFile, chmod, unlink } from 'node:fs/promises';
import { createMonitorService } from './monitor-service.mjs';

const [socket, cli] = process.argv.slice(2);
if (!socket || !cli) {
  throw Error('Broker requires socket and mobilecli path');
}
const template = await readFile(new URL('../ui/monitor.html', import.meta.url), 'utf8');
const service = await createMonitorService({ cli, template });
const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 100000) {
        throw Error('Request too large');
      }
    }
    const { method, params = {} } = JSON.parse(body);
    if (!Object.hasOwn(service.methods, method)) {
      throw Error('Unknown monitor method');
    }
    const result = await service.methods[method](params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result }));
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(socket, resolve);
});
await chmod(socket, 0o600);
let closing = false;
const close = async () => {
  if (closing) {
    return;
  }
  closing = true;
  await service.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await unlink(socket).catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
