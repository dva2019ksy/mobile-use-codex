import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Capture, JpegParser } from './capture.mjs';

test('finds JPEG frames when markers and multipart headers cross transport chunks', () => {
  const parser = new JpegParser();
  const first = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  const second = Buffer.from([0xff, 0xd8, 3, 0xff, 0xd9]);
  const stream = Buffer.concat([
    Buffer.from('--frame\r\n\r\n'),
    first,
    Buffer.from('\r\n--frame\r\n\r\n'),
    second,
  ]);
  const frames = [];
  for (const byte of stream) {
    frames.push(...parser.push(Buffer.from([byte])));
  }
  assert.deepEqual(frames, [first, second]);
});

test('shares capture, drops frames under backpressure and stops on close', () => {
  let starts = 0;
  let killed = false;
  let receivedDevice;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => {
    killed = true;
    child.exitCode = 0;
    return true;
  };
  const capture = new Capture({
    cli: 'mobilecli',
    device: 'android-or-ios-id',
    fps: 30,
    scale: 0.5,
    spawnProcess: (_cli, args) => {
      starts++;
      receivedDevice = args[args.indexOf('--device') + 1];
      return child;
    },
  });
  const response = (block) => {
    const res = new EventEmitter();
    res.writes = [];
    res.write = (packet) => {
      res.writes.push(packet);
      return !block;
    };
    res.end = () => res.emit('close');
    return res;
  };
  const slow = response(true);
  const fast = response(false);
  capture.subscribe(slow);
  capture.subscribe(fast);
  const frame = Buffer.from([0xff, 0xd8, 7, 0xff, 0xd9]);
  child.stdout.write(frame);
  child.stdout.write(frame);
  assert.equal(starts, 1);
  assert.equal(receivedDevice, 'android-or-ios-id');
  assert.equal(slow.writes.length, 1);
  assert.equal(fast.writes.length, 2);
  slow.emit('drain');
  child.stdout.write(frame);
  assert.equal(slow.writes.length, 2);
  assert.equal(capture.status().frames, 3);
  capture.close();
  assert.ok(killed);
  assert.equal(capture.status().viewers, 0);
  assert.equal(capture.status().state, 'closed');
});

test('a capture that never returns a frame times out and releases the viewer', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
    return true;
  };
  const capture = new Capture({
    cli: 'mobilecli',
    device: 'any-device',
    fps: 30,
    scale: 0.5,
    firstFrameTimeoutMs: 10,
    spawnProcess: () => child,
  });
  const viewer = new EventEmitter();
  viewer.end = () => viewer.emit('close');
  capture.subscribe(viewer);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(capture.status().state, 'error');
  assert.equal(capture.status().viewers, 0);
  assert.equal(child.exitCode, 0);
  capture.close();
});

test('MCP viewers share capture, receive the latest frame and expire without a close message', async () => {
  let starts = 0;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
    return true;
  };
  const capture = new Capture({
    cli: 'mobilecli',
    device: 'any-platform',
    fps: 30,
    scale: 0.5,
    viewerLeaseMs: 15,
    spawnProcess: () => {
      starts++;
      return child;
    },
  });
  const waiting = capture.readFrame('viewer-a', 0, 100);
  const first = Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]);
  const latest = Buffer.from([0xff, 0xd8, 2, 0xff, 0xd9]);
  child.stdout.write(first);
  assert.deepEqual((await waiting).frame, first);
  child.stdout.write(latest);
  assert.deepEqual((await capture.readFrame('viewer-b', 0, 0)).frame, latest);
  assert.equal(starts, 1);
  capture.releaseFrameViewer('viewer-a');
  assert.equal(capture.status().viewers, 1);
  assert.equal((await capture.readFrame('viewer-b', 2, 0)).frame, null);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(capture.status().viewers, 0);
  assert.equal(capture.frameEvents.listenerCount('changed'), 0);
  const closed = capture.readFrame('viewer-c', 2, 1000);
  capture.close();
  assert.equal((await closed).status.state, 'closed');
});
