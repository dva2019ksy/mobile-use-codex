import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, stat, unlink, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export function brokerRequest(socket, method, params = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        path: '/rpc',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const value = JSON.parse(body);
            value.error ? reject(Error(value.error)) : resolve(value.result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(35000, () => req.destroy(Error('Monitor service timeout')));
    req.end(JSON.stringify({ method, params }));
  });
}

export async function connectBroker({
  cli,
  template,
  // Stable runtime identity preserves the per-device singleton across plugin names.
  runtimeDir = join(homedir(), '.codex', 'mobile-codex', 'runtime'),
}) {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const socket = join(runtimeDir, 'monitor-v1.sock');
  const lock = join(runtimeDir, 'startup.lock');
  const health = async ({ upgradeIdle = false } = {}) => {
    try {
      const value = await brokerRequest(socket, 'health');
      if (value.version !== '0.1.6') {
        if (value.activeOperations !== 0) {
          throw Error('Monitor service version differs; finish operations before updating');
        }
        if (upgradeIdle) {
          // Only the startup-lock owner retires an idle daemon. Never interrupt device work.
          process.kill(value.pid, 'SIGTERM');
          for (let n = 0; n < 100; n++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            try {
              await brokerRequest(socket, 'health');
            } catch (error) {
              if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error.code)) {
                return null;
              }
              throw error;
            }
          }
          throw Error('Previous monitor service did not stop');
        }
        return null;
      }
      return value;
    } catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) {
        return null;
      }
      throw error;
    }
  };
  let ready = await health();
  for (let attempt = 0; !ready && attempt < 160; attempt++) {
    let owned = false;
    try {
      await mkdir(lock);
      owned = true;
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
      ready = await health({ upgradeIdle: true });
      if (!ready) {
        // The startup lock serializes stale-socket removal and daemon creation.
        await unlink(socket).catch((error) => {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        });
        const log = await open(join(runtimeDir, 'broker.log'), 'a', 0o600);
        try {
          const child = spawn(
            process.execPath,
            [fileURLToPath(new URL('./broker-server.mjs', import.meta.url)), socket, cli],
            { detached: true, stdio: ['ignore', log.fd, log.fd] },
          );
          child.on('error', () => {});
          child.unref();
        } finally {
          await log.close();
        }
        for (let n = 0; n < 100 && !ready; n++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          ready = await health();
        }
        if (!ready) {
          throw Error('Monitor service did not start; inspect broker.log');
        }
      }
    } catch (error) {
      if (owned || error.code !== 'EEXIST') {
        throw error;
      }
      // Recover a startup lock left by a crashed MCP connection, never a live one.
      const age = await stat(lock)
        .then((value) => Date.now() - value.mtimeMs)
        .catch(() => 0);
      if (age > 15000) {
        const owner = await readFile(join(lock, 'owner.json'), 'utf8')
          .then(JSON.parse)
          .catch(() => null);
        let alive = owner?.pid != null;
        if (alive) {
          try {
            process.kill(owner.pid, 0);
          } catch (error) {
            if (error.code === 'ESRCH') {
              alive = false;
            }
          }
        }
        if (!alive) {
          await rm(lock, { recursive: true, force: true });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      ready = await health();
    } finally {
      if (owned) {
        await rm(lock, { recursive: true, force: true });
      }
    }
  }
  if (!ready) {
    throw Error('Monitor service startup is busy');
  }
  await brokerRequest(socket, 'configureRuntime', { cli, template });
  const owner = randomUUID();
  return {
    owner,
    socket,
    pid: ready.pid,
    origin: ready.origin,
    call: (method, params = {}) => brokerRequest(socket, method, { ...params, owner }),
    close: () => brokerRequest(socket, 'releaseOwner', { owner }),
  };
}
