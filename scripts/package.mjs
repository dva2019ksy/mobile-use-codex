import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
if (manifest.name !== pkg.name || manifest.version !== pkg.version) {
  throw Error('Plugin and package identities must match');
}
const run = promisify(execFile);
const stage = await mkdtemp(join(tmpdir(), `${pkg.name}-release-`));
const filename = `${pkg.name}-${pkg.version}.zip`;
const archive = join(root, 'dist', filename);

try {
  // Explicit allowlist keeps dependencies, user state and build output out of releases.
  for (const entry of ['package.json', ...pkg.files]) {
    await cp(join(root, entry), join(stage, entry), { recursive: true });
  }
  await mkdir(join(root, 'dist'), { recursive: true });
  await rm(archive, { force: true });
  await run('zip', ['-q', '-r', archive, '.'], { cwd: stage });
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  await writeFile(`${archive}.sha256`, `${sha256}  ${filename}\n`);
  console.log(JSON.stringify({ archive, sha256 }, null, 2));
} finally {
  await rm(stage, { recursive: true, force: true });
}
