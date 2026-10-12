import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ensureDependencies } from './lib/dependencies.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2];
const entries = {
  monitor: 'server/index.mjs',
  control: 'server/control.mjs',
};

try {
  if (!Object.hasOwn(entries, mode)) {
    throw Error('Usage: node scripts/launch.mjs <monitor|control>');
  }
  await ensureDependencies({ root });
  const entry = join(root, entries[mode]);
  // Load in this process so shutdown signals and stdin reach the actual MCP service.
  process.argv = [process.execPath, entry];
  await import(pathToFileURL(entry).href);
} catch (error) {
  console.error(`[mobile-use-codex] ${error.message}`);
  process.exitCode = 1;
}
