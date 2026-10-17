import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcp } from '../scripts/lib/mcp-client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);

test('one plugin exposes upstream device actions and a shared monitor without external MCP config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mobile-use-codex-plugin-'));
  const cli = join(dir, 'mobilecli');
  const commands = join(dir, 'commands.jsonl');
  const runtime = join(dir, 'runtime');
  const device = {
    id: 'plugin-test-device',
    name: 'Plugin Test Device',
    platform: 'android',
    type: 'real',
    state: 'online',
  };
  await writeFile(
    cli,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(commands)}, JSON.stringify(args) + '\\n');
const ok = data => console.log(JSON.stringify({ status: 'ok', data }));
if (args[0] === '--version') console.log('mobilecli version 1.0.18');
else if (args[0] === 'devices') ok({ devices: [${JSON.stringify(device)}] });
else if (args[0] === 'screencapture') setInterval(() => process.stdout.write(Buffer.from([255,216,255,192,0,11,8,3,32,1,244,1,1,17,0,255,217])), 20);
else if (args[0] === 'device' && args[1] === 'info') ok({ device: { screenSize: { width: 1000, height: 1600, scale: 1 } } });
else if (args[0] === 'dump') {
  if (process.env.MOBILE_CODEX_TEST_UI_FAILURE) console.log(JSON.stringify({ status: 'error', error: 'Synthetic UI read failure' }));
  else ok({ elements: [{ type: 'Button', label: 'Test', ref: '@e1', rect: { x: 90, y: 190, width: 20, height: 20 } }] });
}
else if (args[0] === 'screenshot') process.stdout.write(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64'));
else if (['io', 'apps'].includes(args[0])) ok({});
else { console.error('Unexpected command'); process.exit(1); }
`,
  );
  await chmod(cli, 0o700);
  const clients = [];
  let monitor;
  let operation;
  let brokerPid;
  try {
    const env = { MOBILECLI_PATH: cli, MOBILE_CODEX_RUNTIME_DIR: runtime };
    monitor = await startMcp('mobile-use-codex', { env, cwd: dir });
    clients.push(monitor);
    const control = await startMcp('mobile-control', { env, cwd: dir });
    clients.push(control);
    assert.equal(monitor.initialized.serverInfo.name, 'mobile-use-codex');
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.equal(monitor.initialized.serverInfo.version, pkg.version);
    const resource = (await monitor.request('resources/list', {})).resources[0];
    assert(resource.uri.startsWith(`ui://mobile-use-codex/monitor-${pkg.version}-`));
    assert.match(resource.uri, /[0-9a-f]{12}\.html$/);
    const page = (await monitor.request('resources/read', { uri: resource.uri })).contents[0].text;
    assert(page.includes(`version: '${pkg.version}'`));
    assert(!page.includes('__PLUGIN_VERSION__'));
    assert.equal(control.initialized.serverInfo.name, 'mobile-mcp');
    const controls = (await control.request('tools/list', {})).tools;
    for (const name of [
      'mobile_list_available_devices',
      'mobile_launch_app',
      'mobile_click_on_screen_at_coordinates',
      'mobile_swipe_on_screen',
      'mobile_type_keys',
      'mobile_batch_commands',
      'mobile_list_elements_on_screen',
      'mobile_take_screenshot',
    ]) {
      assert(
        controls.some((tool) => tool.name === name),
        `${name} missing from bundled control`,
      );
    }
    assert.equal(
      controls.find((tool) => tool.name === 'mobile_click_on_screen_at_coordinates').annotations
        .readOnlyHint,
      false,
    );
    const available = await control.call('mobile_list_available_devices');
    assert.equal(JSON.parse(available.content[0].text).devices[0].id, device.id);
    const opened = await monitor.call('open_monitor', { device: device.id });
    assert(!opened.isError, JSON.stringify(opened));
    operation = opened.structuredContent.operation;
    const monitorTools = (await monitor.request('tools/list', {})).tools;
    const buttons = monitorTools.find((tool) => tool.name === 'press_monitor_button');
    assert.equal(buttons.annotations.readOnlyHint, false);
    assert.deepEqual(buttons._meta.ui.visibility, ['app']);
    const tapTool = monitorTools.find((tool) => tool.name === 'tap_monitor_screen');
    assert.equal(tapTool.annotations.readOnlyHint, false);
    assert.deepEqual(tapTool._meta.ui.visibility, ['app']);
    assert.equal(
      monitorTools.find((tool) => tool.name === 'monitor_status')._meta['openai/widgetAccessible'],
      true,
      'paused widgets must be allowed to check lifecycle status',
    );
    for (const button of ['HOME', 'VOLUME_UP', 'VOLUME_DOWN']) {
      assert(!(await monitor.call('press_monitor_button', { device: device.id, button })).isError);
    }
    assert(
      (await monitor.call('press_monitor_button', { device: device.id, button: 'POWER' })).isError,
    );
    const observer = await startMcp('mobile-use-codex', { env, cwd: dir });
    clients.push(observer);
    assert(
      (await observer.call('press_monitor_button', { device: device.id, button: 'HOME' })).isError,
      'another connection cannot control the device using this owner’s lease',
    );
    const frame = await monitor.call('read_frame', {
      device: device.id,
      viewer: 'plugin-test-viewer',
      after: 0,
      waitMs: 1000,
    });
    assert(frame._meta.mobileCodexFrame?.jpeg);
    const tapArgs = {
      device: device.id,
      x: 0.25,
      y: 0.75,
      frameWidth: 500,
      frameHeight: 800,
      sequence: frame.structuredContent.frames,
    };
    const tapped = await monitor.call('tap_monitor_screen', tapArgs);
    assert(!tapped.isError, JSON.stringify(tapped));
    assert.deepEqual(tapped.structuredContent, { x: 250, y: 1200 });
    assert((await observer.call('tap_monitor_screen', tapArgs)).isError);
    assert((await monitor.call('tap_monitor_screen', { ...tapArgs, x: -1 })).isError);
    const elements = await control.call('mobile_list_elements_on_screen', {
      device: device.id,
      format: 'json',
    });
    const elementText = elements.content[0].text;
    assert.equal(JSON.parse(elementText.slice(elementText.indexOf('[')))[0].ref, '@e1');
    const steps = [
      ['mobile_launch_app', { packageName: 'test.app' }],
      ['mobile_click_on_screen_at_coordinates', { ref: '@e1' }],
      ['mobile_swipe_on_screen', { direction: 'up', x: 500, y: 800, distance: 200 }],
      ['mobile_type_keys', { text: 'test', submit: false }],
    ];
    for (const [name, args] of steps) {
      const result = await control.call(name, { device: device.id, ...args });
      assert(!result.isError, JSON.stringify(result));
    }
    const screenshot = await control.call('mobile_take_screenshot', { device: device.id });
    assert(!screenshot.isError, JSON.stringify(screenshot));
    assert(
      screenshot.content.some((part) => part.type === 'image' && part.mimeType === 'image/png'),
    );
    const invalid = await control.call('mobile_type_keys', { text: 'must not run' });
    assert(invalid.isError, 'upstream device argument validation must be preserved');
    const ended = await monitor.call('end_operation', { device: device.id, operation });
    operation = null;
    assert.equal(ended.structuredContent.state, 'idle');
    assert.equal(ended.structuredContent.activeOperations, 0);
    assert.equal(ended.structuredContent.viewers, 1);
    assert(
      (await monitor.call('press_monitor_button', { device: device.id, button: 'HOME' })).isError,
      'controls must not revive an ended operation',
    );
    assert((await monitor.call('tap_monitor_screen', tapArgs)).isError);
    const calls = (await readFile(commands, 'utf8')).trim().split('\n').map(JSON.parse);
    assert(calls.some((args) => args.join(' ') === `apps launch test.app --device ${device.id}`));
    assert(calls.some((args) => args.join(' ') === `io tap @e1 --device ${device.id}`));
    assert(
      calls.some((args) => args.join(' ') === `io swipe 500,800,500,600 --device ${device.id}`),
    );
    assert(calls.some((args) => args.join(' ') === `io text test --device ${device.id}`));
    for (const button of ['HOME', 'VOLUME_UP', 'VOLUME_DOWN']) {
      assert.equal(
        calls.filter((args) => args.join(' ') === `io button ${button} --device ${device.id}`)
          .length,
        1,
      );
    }
    assert.equal(calls.filter((args) => args[0] === 'screencapture').length, 1);
    const smoke = await run(
      process.execPath,
      [join(root, 'scripts/smoke.mjs'), '--device', device.id],
      {
        cwd: dir,
        env: { ...process.env, ...env },
        timeout: 20000,
        maxBuffer: 100000,
      },
    );
    const summary = JSON.parse(smoke.stdout.trim());
    assert.equal(summary.mcp, 'passed');
    assert(summary.httpFrames >= 45);
    assert.equal(summary.mcpFrames, 30);
    assert.equal(summary.stoppedWithViewerOpen, true);
    assert.equal(
      (await monitor.call('monitor_status', { device: device.id })).structuredContent
        .activeOperations,
      0,
    );
    // A read failure after opening the monitor must still release its operation.
    await assert.rejects(
      run(process.execPath, [join(root, 'scripts/smoke.mjs'), '--device', device.id], {
        cwd: dir,
        env: { ...process.env, ...env, MOBILE_CODEX_TEST_UI_FAILURE: '1' },
        timeout: 20000,
        maxBuffer: 100000,
      }),
    );
    const failed = await monitor.call('monitor_status', { device: device.id });
    assert.equal(failed.structuredContent.activeOperations, 0);
    assert.equal(failed.structuredContent.state, 'idle');
  } finally {
    if (operation) {
      await monitor.call('end_operation', { device: device.id, operation }).catch(() => {});
    }
    // The broker is confined to this test's private runtime, never the user's daemon.
    try {
      const { brokerRequest } = await import('./broker-client.mjs');
      brokerPid = (await brokerRequest(join(runtime, 'monitor-v1.sock'), 'health')).pid;
    } catch {
      // Startup may have failed before a broker existed.
    }
    await Promise.all(clients.map((client) => client.close()));
    if (brokerPid) {
      process.kill(brokerPid, 'SIGTERM');
    }
    await rm(dir, { recursive: true, force: true });
  }
});
