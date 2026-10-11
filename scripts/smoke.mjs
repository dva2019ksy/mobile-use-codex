// Read-only device and stream validation; screen data stays in memory.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { JpegParser } from '../server/capture.mjs';
import { startMcp } from './lib/mcp-client.mjs';

const { values } = parseArgs({
  options: { device: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
});
if (values.help || !values.device) {
  console.log('Usage: node scripts/smoke.mjs --device <actual-online-device-id>');
  process.exit(values.help ? 0 : 1);
}

const controller = new AbortController();
const interrupt = () => controller.abort(Error('Smoke test interrupted'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const clients = [];
const device = values.device;
const viewer = `smoke-${randomUUID()}`;
let monitor;
let operation;
function checkTool(result, name) {
  assert(!result.isError, `${name} failed`);
  return result;
}

async function fetchStatus(url) {
  const response = await fetch(url, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
  });
  assert(response.ok, `Status HTTP ${response.status}`);
  return response.json();
}

async function readHttpFrames(config) {
  const response = await fetch(config.streamUrl, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]),
  });
  assert(response.ok, `Stream HTTP ${response.status}`);
  const reader = response.body.getReader();
  try {
    assert(response.headers.get('content-type')?.startsWith('multipart/x-mixed-replace'));
    const parser = new JpegParser();
    let frames = 0;
    while (frames < 45) {
      const { value, done } = await reader.read();
      assert(!done, 'HTTP stream ended before 45 frames');
      frames += parser.push(Buffer.from(value)).length;
    }
    const state = await fetchStatus(config.statusUrl);
    assert(state.frames >= 45, 'Capture did not produce 45 frames');
    return frames;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

try {
  monitor = await startMcp('mobile-use-codex', { timeoutMs: 40000, signal: controller.signal });
  clients.push(monitor);
  const control = await startMcp('mobile-control', {
    timeoutMs: 40000,
    signal: controller.signal,
  });
  clients.push(control);
  assert.equal(monitor.initialized.serverInfo.name, 'mobile-use-codex');
  assert.equal(control.initialized.serverInfo.name, 'mobile-mcp');

  const controls = (await control.request('tools/list', {})).tools;
  assert(controls.some((tool) => tool.name === 'mobile_click_on_screen_at_coordinates'));
  const available = checkTool(
    await control.call('mobile_list_available_devices'),
    'mobile_list_available_devices',
  );
  assert(JSON.parse(available.content[0].text).devices.some((item) => item.id === device));
  const devices = checkTool(await monitor.call('list_devices'), 'list_devices');
  assert(
    devices.structuredContent.devices.some((item) => item.id === device && item.state === 'online'),
    'Requested device is not online',
  );

  const tools = (await monitor.request('tools/list', {})).tools;
  const uri = tools.find((tool) => tool.name === 'open_monitor')._meta.ui.resourceUri;
  const opened = checkTool(await monitor.call('open_monitor', { device }), 'open_monitor');
  operation = opened.structuredContent.operation;
  const config = opened._meta.mobileCodex;
  const resource = (await monitor.request('resources/read', { uri })).contents[0];
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  assert(resource.text.includes('ui/initialize'));
  assert(resource.text.includes('ui/notifications/tool-result'));
  assert(resource._meta.ui.csp.connectDomains.length > 0);
  assert.deepEqual(resource._meta['openai/ui'].availableDisplayModes, ['inline', 'fullscreen']);
  assert.equal(resource._meta['openai/ui'].preferredDisplayMode, 'fullscreen');

  const size = checkTool(
    await control.call('mobile_get_screen_size', { device }),
    'mobile_get_screen_size',
  );
  assert(size.content[0].text.startsWith('Screen size is '));
  const elements = checkTool(
    await control.call('mobile_list_elements_on_screen', { device, format: 'json' }),
    'mobile_list_elements_on_screen',
  );
  const text = elements.content[0].text;
  assert(text.startsWith('Found these elements on screen:'));
  assert(Array.isArray(JSON.parse(text.slice(text.indexOf('[')))));

  const httpFrames = await readHttpFrames(config);
  let after = 0;
  let received = 0;
  let captureFps = 0;
  const deadline = performance.now() + 20000;
  while (received < 30 && performance.now() < deadline) {
    controller.signal.throwIfAborted();
    const result = checkTool(
      await monitor.call('read_frame', { device, viewer, after }),
      'read_frame',
    );
    const frame = result._meta?.mobileCodexFrame;
    if (!frame) {
      continue;
    }
    const jpeg = Buffer.from(frame.jpeg, 'base64');
    assert.equal(jpeg.toString('base64'), frame.jpeg, 'Invalid base64 frame');
    assert(jpeg.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
    assert(jpeg.subarray(-2).equals(Buffer.from([0xff, 0xd9])));
    assert(frame.sequence > after, 'MCP frame sequence did not advance');
    after = frame.sequence;
    captureFps = result.structuredContent.fps;
    received++;
  }
  assert.equal(received, 30, 'MCP stream did not deliver 30 frames');

  const ended = checkTool(
    await monitor.call('end_operation', { device, operation }),
    'end_operation',
  );
  operation = null;
  assert.equal(ended.structuredContent.activeOperations, 0, 'Another operation is still active');
  assert.equal(ended.structuredContent.state, 'idle');
  // Keep the viewer alive: it must not restart capture after the last operation.
  const idle = checkTool(
    await monitor.call('read_frame', { device, viewer, after, waitMs: 0 }),
    'read_frame',
  );
  assert.equal(idle.structuredContent.state, 'idle');
  assert.equal(idle.structuredContent.activeOperations, 0);
  await monitor.call('release_frame_viewer', { device, viewer });
  checkTool(await monitor.call('close_monitor', { device }), 'close_monitor');
  assert.equal((await fetchStatus(config.statusUrl)).state, 'idle');
  console.log(
    JSON.stringify({
      device: config.device.name,
      mcp: 'passed',
      bundledControlTools: controls.length,
      bundledControlScreenRead: true,
      uiResource: uri,
      httpFrames,
      mcpFrames: received,
      captureFps: Math.round(captureFps * 10) / 10,
      stoppedWithViewerOpen: true,
      nativeWidgetRendered: 'requires Codex client verification',
    }),
  );
} finally {
  if (monitor) {
    if (operation) {
      await monitor.call('end_operation', { device, operation }).catch(() => {});
    }
    await monitor.call('release_frame_viewer', { device, viewer }).catch(() => {});
  }
  await Promise.all(clients.map((client) => client.close()));
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
