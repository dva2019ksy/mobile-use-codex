import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function dependenciesReady(root, lockfile) {
  try {
    for (const [path, expected] of Object.entries(lockfile.packages)) {
      if (!path || expected.dev) {
        continue;
      }
      const installed = JSON.parse(
        await readFile(join(root, path, 'package.json'), 'utf8').catch((error) => {
          if (expected.optional && error.code === 'ENOENT') {
            return 'null';
          }
          throw error;
        }),
      );
      if (installed && installed.version !== expected.version) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function install(root, npmCommand, timeoutMs) {
  return new Promise((resolve, reject) => {
    // npm output must never mix with MCP JSON-RPC on stdout.
    const child = spawn(
      npmCommand,
      ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: root, stdio: ['ignore', process.stderr, process.stderr] },
    );
    let timedOut = false;
    const cancel = () => child.kill('SIGTERM');
    process.once('SIGTERM', cancel);
    process.once('SIGINT', cancel);
    const cleanup = () => {
      clearTimeout(timer);
      process.removeListener('SIGTERM', cancel);
      process.removeListener('SIGINT', cancel);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code === 0) {
        resolve();
      } else {
        reject(
          Error(
            timedOut ? 'Dependency installation timed out' : `npm ci failed (${code ?? signal})`,
          ),
        );
      }
    });
  });
}

export async function ensureDependencies({ root, npmCommand = 'npm', timeoutMs = 120000 }) {
  const lockfile = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const lock = join(root, '.install.lock');
  const deadline = Date.now() + timeoutMs + 10000;
  for (;;) {
    if (await dependenciesReady(root, lockfile)) {
      // A second MCP service must wait for npm to finish all transitive dependencies.
      const installing = await stat(lock).then(
        () => true,
        () => false,
      );
      if (!installing) {
        return;
      }
    }
    let owned = false;
    try {
      await mkdir(lock);
      owned = true;
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
      if (!(await dependenciesReady(root, lockfile))) {
        console.error('[mobile-use-codex] Installing locked runtime dependencies…');
        await install(root, npmCommand, timeoutMs);
        if (!(await dependenciesReady(root, lockfile))) {
          throw Error('Dependency installation incomplete');
        }
      }
      return;
    } catch (error) {
      if (owned || error.code !== 'EEXIST') {
        throw error;
      }
      const owner = await readFile(join(lock, 'owner.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      if (owner?.pid) {
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') {
            await rm(lock, { recursive: true, force: true });
          }
        }
      }
      if (Date.now() >= deadline) {
        throw Error(`Dependency installation is busy; inspect ${lock}`, { cause: error });
      }
      await delay(100);
    } finally {
      if (owned) {
        await rm(lock, { recursive: true, force: true });
      }
    }
  }
}
