import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Capture } from './capture.mjs';

const run = promisify(execFile);
export const OPERATION_LEASE_MS = 90000;

// One service owns captures for every MCP connection and diagnostic viewer.
export async function createMonitorService({
  cli,
  template,
  leaseMs = OPERATION_LEASE_MS,
  captureFactory = (options) => new Capture(options),
}) {
  const sessions = new Map();
  const tokens = new Map();
  let origin;
  const status = (session) => ({
    ...session.capture.status(),
    activeOperations: session.operations.size,
  });
  const release = async (session, operation) => {
    const lease = session.operations.get(operation);
    if (!lease) {
      return false;
    }
    clearTimeout(lease.timer);
    session.operations.delete(operation);
    if (!session.operations.size) {
      await session.capture.setCaptureEnabled(false);
    }
    return true;
  };
  const renew = (session, operation, owner) => {
    const lease = session.operations.get(operation);
    if (!lease || lease.owner !== owner) {
      throw Error('Operation has ended or belongs to another connection');
    }
    clearTimeout(lease.timer);
    lease.timer = setTimeout(() => {
      void release(session, operation);
    }, leaseMs);
    lease.timer.unref();
    return { operation, leaseMs, ...status(session) };
  };
  const listDevices = async () => {
    const { stdout } = await run(cli, ['devices'], { timeout: 30000, maxBuffer: 2_000_000 });
    const response = JSON.parse(stdout);
    if (response.status && response.status !== 'ok') {
      throw Error(response.error || 'Device discovery failed');
    }
    const devices = response.data?.devices ?? response.devices ?? response;
    if (!Array.isArray(devices)) {
      throw Error('Unexpected mobilecli device response');
    }
    return devices;
  };
  const http = createServer((req, res) => {
    const [, token, action] = new URL(req.url, 'http://127.0.0.1').pathname.split('/');
    const session = tokens.get(token);
    if (req.method !== 'GET' || !session) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (action === 'stream') {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' });
      res.flushHeaders();
      session.capture.subscribe(res);
    } else if (action === 'status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status(session)));
    } else if (!action) {
      const config = JSON.stringify(session.config).replaceAll('<', '\\u003c');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        template.replace('/* STANDALONE_CONFIG */', `window.mobileCodexStandalone=${config};`),
      );
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${http.address().port}`;
  const requireSession = (device) => {
    const session = sessions.get(device);
    if (!session) {
      throw Error('Monitor session has ended');
    }
    return session;
  };
  const methods = {
    // Broker protocol version, independent of the plugin release.
    health: async () => ({
      version: '0.1.4',
      pid: process.pid,
      origin,
      cli,
      activeOperations: [...sessions.values()].reduce(
        (total, session) => total + session.operations.size,
        0,
      ),
    }),
    async configureRuntime({ cli: nextCli, template: nextTemplate }) {
      if (typeof nextCli !== 'string' || !nextCli) {
        throw Error('A mobilecli path is required');
      }
      // Installed plugin caches can be removed on upgrade. Running captures remain
      // untouched, while discovery and subsequent starts use the current runtime.
      cli = nextCli;
      for (const session of sessions.values()) {
        session.capture.cli = nextCli;
      }
      if (typeof nextTemplate === 'string') {
        template = nextTemplate;
      }
      return methods.health();
    },
    listDevices,
    async openMonitor({ device, owner, fps = 30, scale = 0.5 }) {
      const target = (await listDevices()).find(
        (item) => item.id === device && item.state === 'online',
      );
      if (!target) {
        throw Error('Device is offline or unknown; call list_devices again');
      }
      // Discovery awaits; re-check the shared map afterwards to avoid concurrent creation.
      let session = sessions.get(device);
      if (!session) {
        const token = randomBytes(24).toString('base64url');
        session = {
          device: target,
          operations: new Map(),
          capture: captureFactory({ cli, device, fps, scale, captureEnabled: false }),
          config: {
            device: target,
            streamUrl: `${origin}/${token}/stream`,
            statusUrl: `${origin}/${token}/status`,
            previewUrl: `${origin}/${token}`,
            targetFps: fps,
          },
        };
        sessions.set(device, session);
        tokens.set(token, session);
      }
      // Reopening a monitor from the same connection renews its existing operation.
      let operation = [...session.operations].find(
        ([, value]) => value.owner === owner && value.primary,
      )?.[0];
      if (!operation) {
        operation = randomUUID();
        session.operations.set(operation, { owner, primary: true, timer: null });
      }
      const lease = renew(session, operation, owner);
      await session.capture.setCaptureEnabled(true);
      return { config: session.config, operation, leaseMs: lease.leaseMs, ...status(session) };
    },
    async beginOperation({ device, owner }) {
      const session = requireSession(device);
      const operation = randomUUID();
      session.operations.set(operation, { owner, timer: null });
      renew(session, operation, owner);
      await session.capture.setCaptureEnabled(true);
      return { operation, leaseMs, ...status(session) };
    },
    renewOperation: async ({ device, operation, owner }) =>
      renew(requireSession(device), operation, owner),
    async endOperation({ device, operation, owner }) {
      const session = requireSession(device);
      const lease = session.operations.get(operation);
      if (lease && lease.owner !== owner) {
        throw Error('Operation belongs to another connection');
      }
      await release(session, operation);
      return status(session);
    },
    async closeMonitor({ device, owner }) {
      const session = sessions.get(device);
      if (!session) {
        return { state: 'idle', activeOperations: 0 };
      }
      for (const [operation, lease] of session.operations) {
        if (lease.owner === owner) {
          await release(session, operation);
        }
      }
      return status(session);
    },
    async releaseOwner({ owner }) {
      for (const session of sessions.values()) {
        for (const [operation, lease] of session.operations) {
          if (lease.owner === owner) {
            await release(session, operation);
          }
        }
      }
      return {};
    },
    async readFrame({ device, viewer, after = 0, waitMs = 1000 }) {
      const session = requireSession(device);
      const { frame, status: frameStatus } = await session.capture.readFrame(viewer, after, waitMs);
      return {
        status: { ...frameStatus, activeOperations: session.operations.size },
        frame: frame?.toString('base64') ?? null,
      };
    },
    async releaseViewer({ device, viewer }) {
      sessions.get(device)?.capture.releaseFrameViewer(viewer);
      return {};
    },
    async monitorStatus({ device }) {
      return status(requireSession(device));
    },
    async pressMonitorButton({ device, owner, button }) {
      if (!['HOME', 'VOLUME_UP', 'VOLUME_DOWN'].includes(button)) {
        throw Error('Unsupported monitor button');
      }
      const session = requireSession(device);
      const press = async () => {
        const requireOperation = () => {
          if (![...session.operations.values()].some((lease) => lease.owner === owner)) {
            throw Error('Device operation has ended; open a monitor before using controls');
          }
        };
        const command = async (args, timeout) => {
          requireOperation();
          const { stdout } = await run(cli, [...args, '--device', device], {
            timeout,
            maxBuffer: 100000,
          });
          const response = JSON.parse(stdout);
          if (response.status !== 'ok') {
            throw Error(response.error || 'Device button failed');
          }
          return response.data;
        };
        const pressOnce = () => command(['io', 'button', button], 5000);
        await pressOnce();
        if (button !== 'HOME' || session.device.platform !== 'ios') {
          return { button };
        }
        // iOS may consume the first Home event without leaving the app. Check the
        // actual foreground app before retrying; never send an unconditional double press.
        const isHome = async () => {
          for (const delay of [350, 650]) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            const foreground = await command(['apps', 'foreground'], 1500);
            if (foreground?.packageName === 'com.apple.springboard') {
              return true;
            }
          }
          return false;
        };
        if (await isHome()) {
          return { button, homeVerified: true, presses: 1 };
        }
        await pressOnce();
        if (!(await isHome())) {
          throw Error('未能返回主屏幕，请重试');
        }
        return { button, homeVerified: true, presses: 2 };
      };
      // Multiple widgets may control one device. Preserve the order of button presses.
      const result = (session.controls ?? Promise.resolve()).then(press);
      session.controls = result.catch(() => {});
      return result;
    },
  };
  return {
    methods,
    origin,
    async close() {
      for (const session of sessions.values()) {
        for (const lease of session.operations.values()) {
          clearTimeout(lease.timer);
        }
        session.operations.clear();
        await session.capture.close();
      }
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}
