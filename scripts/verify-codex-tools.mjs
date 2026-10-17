import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { brokerRequest } from '../server/broker-client.mjs';

// Exercise Codex's actual plugin-to-code-mode exposure, not just tools/list.
// A loopback Responses stub emits one catalog-inspection call. No model API,
// device commands, account credentials, or persistent Codex config are used.
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.CODEX_CLI ?? 'codex';
const model = process.env.CODEX_MODEL ?? 'gpt-6.1-sol';
const models =
  process.env.CODEX_MODELS_CACHE ??
  join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const cachedModels = await readFile(models);
// Keep the private broker's Unix socket below macOS's path-length limit.
const temp = await mkdtemp(join(tmpdir(), 'muc-expose-'));
const runtime = join(temp, 'runtime');
const expected = [
  'begin_operation',
  'close_monitor',
  'end_operation',
  'list_devices',
  'monitor_status',
  'open_monitor',
  'renew_operation',
];
const code = `text({monitor:ALL_TOOLS.filter(t=>t.name.startsWith('mcp__mobile_use_codex__')).map(t=>t.name),control:ALL_TOOLS.filter(t=>t.name.startsWith('mcp__mobile_control__')).map(t=>t.name)});`;
let resolveOutput;
let rejectOutput;
const output = new Promise((resolve, reject) => {
  resolveOutput = resolve;
  rejectOutput = reject;
});
let requestCount = 0;
const provider = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks));
    if (++requestCount === 1) {
      const item = {
        type: 'custom_tool_call',
        id: 'ct_probe',
        call_id: 'call_probe',
        name: 'exec',
        namespace: 'functions',
        input: code,
      };
      const response = {
        id: 'resp_probe',
        object: 'response',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      };
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, input: '' } },
        {
          type: 'response.custom_tool_call_input.delta',
          item_id: item.id,
          output_index: 0,
          delta: code,
        },
        {
          type: 'response.custom_tool_call_input.done',
          item_id: item.id,
          output_index: 0,
          input: code,
        },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      );
    } else {
      const result = body.input.find((item) => item.type === 'custom_tool_call_output');
      const text =
        typeof result?.output === 'string'
          ? result.output
          : result?.output?.map((part) => part.text ?? '').join('\n');
      const line = text?.split('\n').find((line) => line.startsWith('{"monitor":'));
      if (!line) {
        throw Error(`Codex did not return the runtime catalog: ${text ?? 'missing output'}`);
      }
      resolveOutput(JSON.parse(line));
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'Local catalog probe complete', type: 'invalid_request_error' },
        }),
      );
    }
  } catch (error) {
    rejectOutput(error);
    res.writeHead(500);
    res.end('Local catalog probe failed');
  }
});
let child;
let lines;
let timer;
let stderr = '';
try {
  const cache = join(temp, 'plugins/cache/mobile-use/mobile-use-codex', pkg.version);
  await mkdir(cache, { recursive: true });
  for (const entry of ['package.json', ...pkg.files]) {
    await cp(join(root, entry), join(cache, entry), { recursive: true });
  }
  await symlink(join(root, 'node_modules'), join(cache, 'node_modules'), 'dir');
  await writeFile(
    join(cache, '.codex-marketplace-install.json'),
    JSON.stringify({
      source_type: 'local',
      source: root,
      ref_name: null,
      sparse_paths: [],
      revision: null,
    }),
  );
  const manifest = JSON.parse(await readFile(join(cache, 'mcp.json'), 'utf8'));
  for (const server of Object.values(manifest.mcpServers)) {
    server.env = { ...server.env, MOBILE_CODEX_RUNTIME_DIR: runtime };
  }
  await writeFile(join(cache, 'mcp.json'), JSON.stringify(manifest));
  await writeFile(join(temp, 'models_cache.json'), cachedModels);
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  await writeFile(
    join(temp, 'config.toml'),
    `
model = ${JSON.stringify(model)}
model_provider = "local_probe"
mcp_optional_startup_grace_ms = 15000
[features]
code_mode_host = true
apps = false
remote_plugin = false
tool_suggest = false
[model_providers.local_probe]
name = "Local catalog probe"
base_url = "http://127.0.0.1:${provider.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[marketplaces.mobile-use]
source_type = "local"
source = ${JSON.stringify(root)}
[plugins."mobile-use-codex@mobile-use"]
enabled = true
`,
  );
  child = spawn(cli, ['app-server'], {
    env: { ...process.env, CODEX_HOME: temp },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let sequence = 0;
  const fail = (error) => {
    rejectOutput(error);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('exit', (code) => fail(Error(`Codex exited (${code}): ${stderr}`)));
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(Error(message.error.message));
      } else {
        entry.resolve(message.result);
      }
    }
  });
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(Error(`${method} timed out: ${stderr}`));
      }, 20000);
      pending.set(id, { resolve, reject, timer: timeout });
      send({ id, method, params });
    });
  // Attach a rejection handler before startup, even if an earlier RPC fails.
  output.catch(() => {});
  await rpc('initialize', {
    clientInfo: { name: 'Codex Desktop', version: '1' },
    capabilities: { experimentalApi: true },
  });
  send({ method: 'initialized', params: {} });
  const catalog = await rpc('mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly' });
  for (const [name, count] of [
    ['mobile-control', 33],
    ['mobile-use-codex', 11],
  ]) {
    const server = catalog.data.find((server) => server.name === name);
    assert.equal(
      server?.pluginId,
      'mobile-use-codex@mobile-use',
      `${name} must load as part of the plugin`,
    );
    assert.equal(
      Object.keys(server.tools).length,
      count,
      `${name} raw catalog incomplete: ${server.toolsError ?? server.runtimeStatus}; ${stderr}`,
    );
  }
  const { thread } = await rpc('thread/start', {
    model,
    modelProvider: 'local_probe',
    cwd: temp,
    ephemeral: true,
    approvalPolicy: 'never',
    sandbox: 'read-only',
  });
  await rpc('mcpServerStatus/list', {
    threadId: thread.id,
    limit: 100,
    detail: 'toolsAndAuthOnly',
  });
  await rpc('turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: 'Inspect the runtime tool catalog only.', text_elements: [] }],
  });
  timer = setTimeout(() => rejectOutput(Error(`Runtime probe timed out: ${stderr}`)), 20000);
  const exposed = await output;
  assert.deepEqual(
    exposed.monitor.sort(),
    expected.map((name) => `mcp__mobile_use_codex__${name}`),
  );
  assert.equal(exposed.control.length, 33);
  console.log(
    JSON.stringify(
      {
        plugin: `${pkg.name}@${pkg.version}`,
        monitorTools: exposed.monitor.length,
        controlTools: exposed.control.length,
        codexExposure: 'passed',
      },
      null,
      2,
    ),
  );
} finally {
  clearTimeout(timer);
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.stdin.end();
    const terminate = setTimeout(() => child.kill('SIGTERM'), 1000);
    const force = setTimeout(() => child.kill('SIGKILL'), 4000);
    await exited;
    clearTimeout(terminate);
    clearTimeout(force);
  }
  lines?.close();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  try {
    const { pid } = await brokerRequest(join(runtime, 'monitor-v1.sock'), 'health');
    process.kill(pid, 'SIGTERM');
  } catch {
    // No broker exists when startup fails before loading the monitor service.
  }
  await rm(temp, { recursive: true, force: true });
}
