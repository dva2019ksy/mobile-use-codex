import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { startMcp } from '../scripts/lib/mcp-client.mjs';
import { ControlTransport } from './control-transport.mjs';

const require = createRequire(import.meta.url);
const { createMcpServer } = require('@mobilenext/mobile-mcp/lib/server.js');

async function upstreamCatalog() {
  const server = createMcpServer();
  const [client, transport] = InMemoryTransport.createLinkedPair();
  let sequence = 0;
  const pending = new Map();
  client.onmessage = (response) => {
    const entry = pending.get(response.id);
    if (entry) {
      pending.delete(response.id);
      if (response.error) {
        entry.reject(Error(response.error.message));
      } else {
        entry.resolve(response.result);
      }
    }
  };
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      client.send({ jsonrpc: '2.0', id, method, params }).catch(reject);
    });
  await client.start();
  await server.connect(transport);
  try {
    const initialized = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'control-catalog-test', version: '1' },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return {
      initialized,
      tools: JSON.parse(JSON.stringify((await request('tools/list')).tools)),
    };
  } finally {
    await server.close();
    await client.close();
  }
}

test('bundled control preserves the entire upstream catalog and delegates shared workflow to the skill', async () => {
  const upstream = await upstreamCatalog();
  const client = await startMcp('mobile-control');
  try {
    const { tools } = await client.request('tools/list', {});
    assert.equal(tools.length, 33);
    assert.deepEqual(tools, upstream.tools);
    assert.equal(Object.hasOwn(client.initialized, 'instructions'), false);
    const upstreamHandshake = { ...upstream.initialized };
    delete upstreamHandshake.instructions;
    assert.deepEqual(client.initialized, upstreamHandshake);
    // The skill now owns these rules. An upstream change requires reviewing
    // the workflow migration, rather than silently dropping newly added rules.
    assert.equal(
      createHash('sha256').update(upstream.initialized.instructions).digest('hex'),
      '4cce7baffd6ea78370dafd9271270ed1007ff32b701012e6fa03c7baf89b7512',
      'Upstream workflow changed: review skills/mobile-monitor/SKILL.md before updating this snapshot',
    );
  } finally {
    await client.close();
  }
});

test('control transport only removes instructions from correlated initialize responses', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new ControlTransport(input, output);
  const received = [];
  output.on('data', (chunk) => received.push(JSON.parse(chunk)));
  const handshakes = [
    { protocolVersion: '2025-06-18', capabilities: { tools: {} } },
    { resultType: 'complete', capabilities: { tools: {} } },
  ];
  await transport.start();
  for (const fields of handshakes) {
    const id = fields.protocolVersion ? 1 : 'modern-initialize';
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: {} }) + '\n');
    const message = {
      jsonrpc: '2.0',
      id,
      result: {
        ...fields,
        serverInfo: { name: 'mobile-mcp', version: 'test' },
        instructions: 'Long upstream instructions',
      },
    };
    const before = structuredClone(message);
    await transport.send(message);
    const result = { ...message.result };
    delete result.instructions;
    assert.deepEqual(received.at(-1), { ...message, result });
    assert.deepEqual(message, before, 'transport must not mutate upstream messages');
  }
  const messages = [
    {
      jsonrpc: '2.0',
      id: 10,
      result: { tools: [{ name: 'unchanged', description: 'Full text' }] },
    },
    {
      jsonrpc: '2.0',
      id: 3,
      result: {
        content: [{ type: 'image', data: '/9j/', mimeType: 'image/jpeg' }],
        structuredContent: { tools: [{ name: 'device data, not a catalog' }] },
        _meta: { marker: 'preserved' },
      },
    },
    { jsonrpc: '2.0', id: 4, error: { code: -32602, message: 'Invalid device' } },
    { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
    {
      jsonrpc: '2.0',
      id: 11,
      result: {
        serverInfo: { name: 'tool data' },
        instructions: 'Tool result, not an initialize response',
      },
    },
  ];
  for (const message of messages) {
    await transport.send(message);
    assert.deepEqual(received.at(-1), message);
  }
  // Initialization errors are passed through and clear the request tracking.
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'initialize', params: {} }) + '\n');
  const error = { jsonrpc: '2.0', id: 12, error: { code: -32602, message: 'Invalid initialize' } };
  await transport.send(error);
  assert.deepEqual(received.at(-1), error);
  const later = { jsonrpc: '2.0', id: 12, result: { instructions: 'Unrelated result' } };
  await transport.send(later);
  assert.deepEqual(received.at(-1), later);
  await transport.close();
  input.destroy();
  output.destroy();
});
