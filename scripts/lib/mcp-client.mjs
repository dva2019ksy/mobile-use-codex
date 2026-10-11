import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8'));

// Launch exactly what the plugin declares, with no Codex/global MCP configuration.
export async function startMcp(name, { env = {}, cwd = root, timeoutMs = 15000, signal } = {}) {
  const config = manifest.mcpServers[name];
  const child = spawn(
    config.command === 'node' ? process.execPath : config.command,
    config.args.map((arg) => arg.replaceAll('${PLUGIN_ROOT}', root)),
    { cwd, env: { ...process.env, ...config.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const pending = new Map();
  let sequence = 0;
  let diagnostic = '';
  let terminalError;
  child.stderr.on('data', (chunk) => {
    diagnostic = (diagnostic + chunk).slice(-4000);
  });
  const rejectPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  const fail = (error) => {
    terminalError = error;
    rejectPending(error);
  };
  child.stdin.on('error', fail);
  child.on('error', fail);
  child.on('exit', (code) => fail(Error(`${name} exited (${code}): ${diagnostic}`)));
  const cancel = () => rejectPending(signal.reason ?? Error('Interrupted'));
  signal?.addEventListener('abort', cancel, { once: true });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      fail(Error(`${name} wrote non-JSON to stdout`));
      return;
    }
    const entry = pending.get(response.id);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(response.id);
    if (response.error) {
      entry.reject(Error(response.error.message));
    } else {
      entry.resolve(response.result);
    }
  });
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      if (terminalError) {
        reject(terminalError);
        return;
      }
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`${name} ${method} timed out: ${diagnostic}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      signal?.removeEventListener('abort', cancel);
      lines.close();
      return;
    }
    const exited = once(child, 'exit');
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 500);
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
      clearTimeout(force);
      signal?.removeEventListener('abort', cancel);
      lines.close();
    }
  };
  try {
    signal?.throwIfAborted();
    const initialized = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mobile-use-codex-validation', version: '1' },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return {
      initialized,
      request,
      call: (tool, args = {}) => request('tools/call', { name: tool, arguments: args }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
