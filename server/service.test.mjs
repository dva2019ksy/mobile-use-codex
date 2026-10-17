import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { brokerRequest, connectBroker } from './broker-client.mjs';
import { createMonitorService } from './monitor-service.mjs';
import { Capture } from './capture.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'mc-'));
  const cli = join(dir, 'mobilecli');
  const counts = join(dir, 'starts');
  await writeFile(
    cli,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
if (process.argv[2] === 'devices') { console.log(JSON.stringify({ devices: [{ id: 'test-device', name: 'Test', state: 'online', platform: 'android' }] })); }
else { appendFileSync(${JSON.stringify(counts)}, process.pid + '\\n'); setInterval(() => process.stdout.write(Buffer.from([255,216,1,255,217])), 20); }
`,
  );
  await chmod(cli, 0o700);
  return { dir, cli, counts };
}

for (const pressesToHome of [1, 2, 3]) {
  test(`iOS Home verifies the desktop and retries only if needed (required presses: ${pressesToHome})`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-home-'));
    const cli = join(dir, 'mobilecli');
    const counter = join(dir, 'presses');
    await writeFile(counter, '0');
    await writeFile(
      cli,
      `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const count = () => Number(readFileSync(${JSON.stringify(counter)}, 'utf8'));
let data;
if (args[0] === 'devices') data = { devices: [{ id: 'ipad', name: 'Test iPad', platform: 'ios', state: 'online' }] };
else if (args[0] === 'io' && args[1] === 'button') { writeFileSync(${JSON.stringify(counter)}, String(count() + 1)); data = {}; }
else if (args[0] === 'apps' && args[1] === 'foreground') data = { packageName: count() >= ${pressesToHome} ? 'com.apple.springboard' : 'com.apple.mobilesafari' };
else process.exit(1);
console.log(JSON.stringify({ status: 'ok', data }));
`,
    );
    await chmod(cli, 0o700);
    const service = await createMonitorService({ cli, template: '' });
    t.after(async () => {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    });
    await service.methods.openMonitor({ device: 'ipad', owner: 'test' });
    const result = service.methods.pressMonitorButton({
      device: 'ipad',
      owner: 'test',
      button: 'HOME',
    });
    if (pressesToHome === 3) {
      await assert.rejects(result, /未能返回主屏幕/);
    } else {
      assert.deepEqual(await result, {
        button: 'HOME',
        homeVerified: true,
        presses: pressesToHome,
      });
    }
    assert.equal(Number(await readFile(counter, 'utf8')), Math.min(pressesToHome, 2));
  });
}

for (const activeOperations of [0, 1]) {
  test(`an older broker is upgraded only when idle (active operations: ${activeOperations})`, async (t) => {
    const { dir, cli } = await fixture();
    const socket = join(dir, 'monitor-v1.sock');
    const legacy = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { createServer } from 'node:http';
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => res.end(JSON.stringify({ result: {
    version: '0.1.2', pid: process.pid, activeOperations: ${activeOperations}
  } })));
});
server.listen(${JSON.stringify(socket)}, () => process.stdout.write('ready'));`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let broker;
    t.after(async () => {
      if (broker) {
        await broker.close();
        process.kill(broker.pid, 'SIGTERM');
      }
      if (legacy.exitCode === null && legacy.signalCode === null) {
        legacy.kill('SIGTERM');
      }
      await rm(dir, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
      legacy.stdout.once('data', resolve);
      legacy.once('error', reject);
      legacy.once('exit', () => reject(Error('Legacy fixture exited before listening')));
    });
    if (activeOperations) {
      await assert.rejects(connectBroker({ cli, runtimeDir: dir }), /finish operations/);
      assert.equal(legacy.signalCode, null);
      assert.equal((await brokerRequest(socket, 'health')).activeOperations, 1);
    } else {
      broker = await connectBroker({ cli, runtimeDir: dir });
      assert.notEqual(broker.pid, legacy.pid);
      assert.equal((await broker.call('health')).version, '0.1.6');
    }
  });
}

test('independent connections share a daemon and capture; finishing one preserves another; the last stops despite viewers', async (t) => {
  const { dir, cli, counts } = await fixture();
  const [a, b, c] = await Promise.all([0, 1, 2].map(() => connectBroker({ cli, runtimeDir: dir })));
  t.after(async () => {
    await Promise.all([a.close(), b.close(), c.close()]);
    process.kill(a.pid, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal(a.pid, b.pid);
  assert.equal(b.pid, c.pid);
  assert.notEqual(a.pid, process.pid);
  const [one, two] = await Promise.all([
    a.call('openMonitor', { device: 'test-device' }),
    b.call('openMonitor', { device: 'test-device' }),
  ]);
  assert.equal(one.config.previewUrl, two.config.previewUrl);
  assert.equal((await a.call('openMonitor', { device: 'test-device' })).operation, one.operation);
  await Promise.all([
    a.call('readFrame', { device: 'test-device', viewer: 'viewer-a', waitMs: 1000 }),
    b.call('readFrame', { device: 'test-device', viewer: 'viewer-b', waitMs: 1000 }),
  ]);
  assert.equal((await readFile(counts, 'utf8')).trim().split('\n').length, 1);
  await assert.rejects(
    b.call('endOperation', { device: 'test-device', operation: one.operation }),
    /another connection/,
  );
  const extra = await a.call('beginOperation', { device: 'test-device' });
  assert.equal(
    (await a.call('endOperation', { device: 'test-device', operation: one.operation }))
      .activeOperations,
    2,
  );
  const reopened = await a.call('openMonitor', { device: 'test-device' });
  assert.notEqual(reopened.operation, extra.operation);
  await a.call('endOperation', { device: 'test-device', operation: reopened.operation });
  assert.equal(
    (await a.call('endOperation', { device: 'test-device', operation: extra.operation }))
      .activeOperations,
    1,
  );
  assert.equal((await b.call('monitorStatus', { device: 'test-device' })).state, 'streaming');
  const ended = await b.call('endOperation', { device: 'test-device', operation: two.operation });
  assert.equal(ended.activeOperations, 0);
  assert.equal(ended.state, 'idle');
  assert.equal(ended.viewers, 2);
  const frames = ended.frames;
  await a.call('readFrame', {
    device: 'test-device',
    viewer: 'viewer-a',
    after: frames,
    waitMs: 50,
  });
  assert.equal((await a.call('monitorStatus', { device: 'test-device' })).frames, frames);
  assert.equal((await readFile(counts, 'utf8')).trim().split('\n').length, 1);
  const next = await c.call('openMonitor', { device: 'test-device' });
  assert.equal(next.config.previewUrl, one.config.previewUrl);
  await c.call('readFrame', {
    device: 'test-device',
    viewer: 'viewer-c',
    after: frames,
    waitMs: 1000,
  });
  assert.equal((await readFile(counts, 'utf8')).trim().split('\n').length, 2);
  await c.close();
  assert.equal((await b.call('monitorStatus', { device: 'test-device' })).state, 'idle');
});

test('a plugin upgrade refreshes runtime paths without interrupting or duplicating capture', async (t) => {
  const { dir, cli, counts } = await fixture();
  const a = await connectBroker({ cli, runtimeDir: dir });
  let b;
  t.after(async () => {
    await a.close();
    await b?.close();
    process.kill(a.pid, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dir, { recursive: true, force: true });
  });
  const first = await a.call('openMonitor', { device: 'test-device' });
  await a.call('readFrame', { device: 'test-device', viewer: 'watching', waitMs: 1000 });
  const nextCli = join(dir, 'mobilecli-v2');
  await rename(cli, nextCli);
  b = await connectBroker({ cli: nextCli, runtimeDir: dir });
  assert.equal(b.pid, a.pid);
  assert.equal((await b.call('health')).cli, nextCli);
  assert.equal((await b.call('health')).activeOperations, 1);
  assert.equal((await b.call('listDevices'))[0].id, 'test-device');
  assert.equal((await b.call('monitorStatus', { device: 'test-device' })).state, 'streaming');
  assert.equal((await readFile(counts, 'utf8')).trim().split('\n').length, 1);
  const ended = await a.call('endOperation', {
    device: 'test-device',
    operation: first.operation,
  });
  assert.equal(ended.state, 'idle');
  const second = await b.call('openMonitor', { device: 'test-device' });
  await b.call('readFrame', {
    device: 'test-device',
    viewer: 'watching',
    after: ended.frames,
    waitMs: 1000,
  });
  assert.equal((await readFile(counts, 'utf8')).trim().split('\n').length, 2);
  await b.call('endOperation', { device: 'test-device', operation: second.operation });
  assert.equal((await b.call('health')).activeOperations, 0);
});

test('an abandoned operation expires while a widget is still reading; a viewer cannot revive capture', async (t) => {
  const { cli, dir } = await fixture();
  let starts = 0;
  let killed = 0;
  const service = await createMonitorService({
    cli,
    template: '',
    leaseMs: 40,
    captureFactory: (options) =>
      new Capture({
        ...options,
        spawnProcess: () => {
          starts++;
          const child = new EventEmitter();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.exitCode = null;
          child.kill = () => {
            killed++;
            child.exitCode = 0;
            queueMicrotask(() => child.emit('close', 0));
            return true;
          };
          return child;
        },
      }),
  });
  t.after(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { operation } = await service.methods.openMonitor({ device: 'test-device', owner: 'one' });
  await service.methods.readFrame({ device: 'test-device', viewer: 'still-open', waitMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(starts, 1);
  assert.equal(killed, 1);
  assert.equal(
    (await service.methods.monitorStatus({ device: 'test-device' })).activeOperations,
    0,
  );
  await service.methods.readFrame({ device: 'test-device', viewer: 'still-open', waitMs: 0 });
  assert.equal(starts, 1);
  await assert.rejects(
    service.methods.renewOperation({ device: 'test-device', owner: 'one', operation }),
    /ended/,
  );
});

test('restart waits for the previous child to exit, including when operations overlap shutdown', async () => {
  const children = [];
  const capture = new Capture({
    cli: 'unused',
    device: 'test',
    fps: 30,
    scale: 0.5,
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.kill = () => true;
      children.push(child);
      return child;
    },
  });
  await capture.readFrame('watching', 0, 0);
  const stopped = capture.setCaptureEnabled(false);
  await capture.setCaptureEnabled(true);
  assert.equal(children.length, 1);
  children[0].exitCode = 0;
  children[0].emit('close', 0);
  await stopped;
  assert.equal(children.length, 2);
  const closed = capture.close();
  children[1].exitCode = 0;
  children[1].emit('close', 0);
  await closed;
});
