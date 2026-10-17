import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jpegSize, screenPoint } from './screen-point.mjs';
import { createMonitorService } from './monitor-service.mjs';

test('maps displayed JPEG positions to native input across scales and both orientations', () => {
  for (const [width, height] of [
    [1112, 834],
    [834, 1112],
    [393, 852],
  ]) {
    for (const scale of [0.25, 0.5, 1.5]) {
      const frame = { frameWidth: width * scale, frameHeight: height * scale };
      assert.deepEqual(screenPoint({ ...frame, x: 0.25, y: 0.75 }, { width, height }), {
        x: Math.floor(width * 0.25),
        y: Math.floor(height * 0.75),
      });
      assert.deepEqual(screenPoint({ ...frame, x: 1, y: 0 }, { width, height }), {
        x: width - 1,
        y: 0,
      });
    }
  }
  assert.deepEqual(
    screenPoint(
      { x: 0.5, y: 0.5, frameWidth: 1112, frameHeight: 834 },
      { width: 834, height: 1112 },
    ),
    { x: 556, y: 417 },
  );
  for (const x of [-0.1, 1.1, NaN, Infinity]) {
    assert.throws(
      () =>
        screenPoint({ x, y: 0.5, frameWidth: 400, frameHeight: 300 }, { width: 800, height: 600 }),
      /Invalid/,
    );
  }
});

function jpeg(width, height, marker = 0xc0) {
  return Buffer.from([
    255,
    216,
    255,
    224,
    0,
    4,
    1,
    2,
    255,
    marker,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    17,
    0,
    255,
    217,
  ]);
}

test('reads baseline and progressive JPEG dimensions and rejects malformed frames', () => {
  for (const marker of [0xc0, 0xc2]) {
    assert.deepEqual(jpegSize(jpeg(1112, 834, marker)), { width: 1112, height: 834 });
  }
  for (const data of [null, Buffer.from([255, 216, 255]), jpeg(0, 1), jpeg(1, 1).subarray(0, 14)]) {
    assert.equal(jpegSize(data), null);
  }
});

test('widget taps require an owned live frame, current orientation, and a lease after screen lookup', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mc-tap-'));
  const cli = join(dir, 'mobilecli');
  const taps = join(dir, 'taps');
  const size = join(dir, 'size');
  await writeFile(size, JSON.stringify({ width: 1112, height: 834 }));
  await writeFile(
    cli,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args=process.argv.slice(2);
let data;
if(args[0]==='devices') data={devices:[{id:'ipad',name:'iPad',platform:'ios',state:'online'}]};
else if(args[0]==='device') data={device:{screenSize:JSON.parse(readFileSync(${JSON.stringify(size)},'utf8'))}};
else if(args[0]==='io') {appendFileSync(${JSON.stringify(taps)},args[2]+'\\n');data={};}
else process.exit(1);
console.log(JSON.stringify({status:'ok',data}));
`,
  );
  await chmod(cli, 0o700);
  let live = { state: 'streaming', frames: 100, ageMs: 0 };
  let latestFrame = jpeg(556, 417);
  let suspended = false;
  let duringControl;
  const service = await createMonitorService({
    cli,
    template: '',
    captureFactory: () => ({
      status: () => live,
      get latestFrame() {
        return latestFrame;
      },
      setCaptureEnabled: async () => {},
      withControl: async (action) => {
        suspended = true;
        try {
          await duringControl?.();
          return await action();
        } finally {
          suspended = false;
        }
      },
      close: async () => {},
    }),
  });
  t.after(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { operation } = await service.methods.openMonitor({ device: 'ipad', owner: 'owner' });
  const args = {
    device: 'ipad',
    owner: 'owner',
    x: 0.25,
    y: 0.75,
    frameWidth: 556,
    frameHeight: 417,
    sequence: 99,
  };
  await assert.rejects(service.methods.tapMonitorScreen({ ...args, owner: 'observer' }), /ended/);
  assert.equal(suspended, false);
  assert.deepEqual(await service.methods.tapMonitorScreen(args), { x: 278, y: 625 });
  assert.equal(await readFile(taps, 'utf8'), '278,625\n');
  await writeFile(size, JSON.stringify({ width: 834, height: 1112 }));
  latestFrame = jpeg(417, 556);
  await assert.rejects(service.methods.tapMonitorScreen(args), /方向已变化/);
  latestFrame = jpeg(556, 417);
  for (const state of [
    { state: 'idle', frames: 100, ageMs: 0 },
    { state: 'streaming', frames: 100, ageMs: 3000 },
    { state: 'streaming', frames: 200, ageMs: 0 },
  ]) {
    live = state;
    await assert.rejects(service.methods.tapMonitorScreen(args), /实时画面/);
  }
  live = { state: 'streaming', frames: 100, ageMs: 0 };
  duringControl = () => service.methods.endOperation({ device: 'ipad', owner: 'owner', operation });
  await assert.rejects(service.methods.tapMonitorScreen(args), /ended/);
  assert.equal(suspended, false);
  assert.equal(await readFile(taps, 'utf8'), '278,625\n');
});
