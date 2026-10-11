import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';

// A bounded JPEG parser independent of the device platform and HTTP framing.
export class JpegParser {
  buffer = Buffer.alloc(0);
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    for (;;) {
      const start = this.buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        this.buffer = this.buffer.subarray(-1);
        break;
      }
      const end = this.buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        this.buffer = this.buffer.subarray(start);
        break;
      }
      frames.push(this.buffer.subarray(start, end + 2));
      this.buffer = this.buffer.subarray(end + 2);
    }
    if (this.buffer.length > 20_000_000) {
      throw new Error('Invalid or oversized JPEG frame');
    }
    return frames;
  }
}

export class Capture {
  clients = new Map();
  child = null;
  idleTimer = null;
  frameTimer = null;
  arrivals = [];
  frames = 0;
  error = null;
  stopped = false;
  latestFrame = null;
  frameEvents = new EventEmitter();
  frameViewers = new Map();
  stopping = null;
  captureEnabled = true;
  constructor({
    cli,
    device,
    fps,
    scale,
    spawnProcess = spawn,
    firstFrameTimeoutMs = 20000,
    frameTimeoutMs = 10000,
    viewerLeaseMs = 5000,
    captureEnabled = true,
  }) {
    Object.assign(this, {
      cli,
      device,
      fps,
      scale,
      spawnProcess,
      firstFrameTimeoutMs,
      frameTimeoutMs,
      viewerLeaseMs,
      captureEnabled,
    });
    this.frameEvents.setMaxListeners(100);
  }

  subscribe(res) {
    if (this.stopped) {
      throw new Error('Monitor is closed');
    }
    clearTimeout(this.idleTimer);
    const client = { blocked: false };
    this.clients.set(res, client);
    res.on('drain', () => {
      client.blocked = false;
    });
    res.on('close', () => {
      this.clients.delete(res);
      if (!this.clients.size && !this.stopped) {
        this.idleTimer = setTimeout(() => this.stopCapture(), 1000);
        this.idleTimer.unref();
      }
    });
    this.startCapture();
  }

  async readFrame(viewer, after = 0, waitMs = 1000) {
    if (this.stopped) {
      throw new Error('Monitor is closed');
    }
    let lease = this.frameViewers.get(viewer);
    if (!lease) {
      const res = new EventEmitter();
      res.write = () => true;
      res.end = () => res.emit('close');
      lease = { res, timer: null };
      this.frameViewers.set(viewer, lease);
      res.once('close', () => {
        clearTimeout(lease.timer);
        this.frameViewers.delete(viewer);
      });
      this.subscribe(res);
    }
    clearTimeout(lease.timer);
    lease.timer = setTimeout(() => this.releaseFrameViewer(viewer), this.viewerLeaseMs + waitMs);
    lease.timer.unref();
    if (this.captureEnabled && (!this.latestFrame || this.frames <= after) && !this.error) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.frameEvents.off('changed', done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        this.frameEvents.once('changed', done);
      });
    }
    return { status: this.status(), frame: this.frames > after ? this.latestFrame : null };
  }

  releaseFrameViewer(viewer) {
    const lease = this.frameViewers.get(viewer);
    if (!lease) {
      return;
    }
    clearTimeout(lease.timer);
    lease.res.end();
  }

  startCapture() {
    if (this.child || this.stopped || !this.captureEnabled || !this.clients.size) {
      return;
    }
    this.arrivals = [];
    this.latestFrame = null;
    this.error = null;
    const parser = new JpegParser();
    const child = this.spawnProcess(
      this.cli,
      [
        'screencapture',
        '--device',
        this.device,
        '--format',
        'mjpeg',
        '--fps',
        String(this.fps),
        '--scale',
        String(this.scale),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;
    this.watchFrames(this.firstFrameTimeoutMs);
    let diagnostic = '';
    child.stderr.on('data', (data) => {
      diagnostic = (diagnostic + data).slice(-1500);
    });
    child.stdout.on('data', (data) => {
      if (this.child !== child || this.stopping || !this.captureEnabled) {
        return;
      }
      try {
        for (const frame of parser.push(data)) {
          this.publish(frame);
        }
      } catch (error) {
        this.error = error.message;
        for (const res of this.clients.keys()) {
          res.end();
        }
        this.clients.clear();
        this.stopCapture();
        this.frameEvents.emit('changed');
      }
    });
    child.on('error', (error) => {
      this.error = error.message;
    });
    child.on('close', (code) => {
      if (this.child !== child) {
        return;
      }
      clearTimeout(this.frameTimer);
      this.child = null;
      const stopping = this.stopping;
      this.stopping = null;
      if (stopping) {
        clearTimeout(stopping.timer);
        stopping.resolve();
        if (this.captureEnabled && !this.stopped) {
          this.startCapture();
        }
        this.frameEvents.emit('changed');
        return;
      }
      if (code && !this.error) {
        this.error = diagnostic.trim() || `Capture exited (${code})`;
      }
      for (const res of this.clients.keys()) {
        res.end();
      }
      this.clients.clear();
      this.frameEvents.emit('changed');
    });
  }

  publish(frame) {
    this.watchFrames(this.frameTimeoutMs);
    const now = performance.now();
    this.frames++;
    this.latestFrame = frame;
    this.frameEvents.emit('changed');
    this.arrivals.push(now);
    while (
      this.arrivals.length > 120 ||
      (this.arrivals.length > 1 && this.arrivals[0] < now - 2000)
    ) {
      this.arrivals.shift();
    }
    const packet = Buffer.concat([
      Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`),
      frame,
      Buffer.from('\r\n'),
    ]);
    for (const [res, client] of this.clients) {
      // Do not queue old frames behind a viewer that cannot keep up.
      if (client.blocked || res.destroyed) {
        continue;
      }
      client.blocked = !res.write(packet);
    }
  }

  watchFrames(timeout) {
    clearTimeout(this.frameTimer);
    this.frameTimer = setTimeout(() => {
      this.error = '设备未返回画面；请确认设备已解锁、连接正常，然后重连。';
      for (const res of this.clients.keys()) {
        res.end();
      }
      this.clients.clear();
      this.stopCapture();
      this.frameEvents.emit('changed');
    }, timeout);
    this.frameTimer.unref();
  }

  status() {
    const first = this.arrivals[0];
    const last = this.arrivals.at(-1);
    const fps =
      this.child &&
      !this.stopping &&
      this.captureEnabled &&
      this.arrivals.length > 1 &&
      last > first
        ? ((this.arrivals.length - 1) * 1000) / (last - first)
        : 0;
    return {
      state: this.stopped
        ? 'closed'
        : this.error
          ? 'error'
          : this.child && !this.stopping && this.captureEnabled
            ? 'streaming'
            : 'idle',
      fps,
      targetFps: this.fps,
      frames: this.frames,
      viewers: this.clients.size,
      ageMs: last === undefined ? null : performance.now() - last,
      error: this.error,
    };
  }

  stopCapture() {
    clearTimeout(this.frameTimer);
    const child = this.child;
    if (!child) {
      return Promise.resolve();
    }
    if (this.stopping) {
      return this.stopping.promise;
    }
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }, 2000);
    timer.unref();
    this.stopping = { promise, resolve, timer };
    child.kill('SIGTERM');
    return promise;
  }

  setCaptureEnabled(enabled) {
    this.captureEnabled = enabled;
    this.frameEvents.emit('changed');
    if (enabled) {
      this.startCapture();
      return Promise.resolve();
    }
    return this.stopCapture();
  }

  close() {
    this.stopped = true;
    clearTimeout(this.idleTimer);
    const stopped = this.stopCapture();
    for (const res of this.clients.keys()) {
      res.end();
    }
    this.clients.clear();
    this.frameEvents.emit('changed');
    return stopped;
  }
}
