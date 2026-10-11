import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDependencies } from '../scripts/lib/dependencies.mjs';

const run = promisify(execFile);

test('concurrent MCP launches install once, keep stdout clean and repair transitive dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mobile-use-install-'));
  const npm = join(root, 'npm-fixture.mjs');
  const runner = join(root, 'runner.mjs');
  const packages = {
    '': { dependencies: { example: '1.0.0' } },
    'node_modules/example': { version: '1.0.0' },
    'node_modules/transitive': { version: '2.0.0' },
  };
  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { example: '1.0.0' } }),
    );
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages }));
    await writeFile(
      npm,
      `#!${process.execPath}
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
await appendFile('calls', JSON.stringify(process.argv.slice(2)) + '\\n');
console.log('npm diagnostic on stdout');
console.error('npm diagnostic on stderr');
if (process.env.INSTALL_TEST_FAIL) process.exit(7);
for (const [name, version] of [['example','1.0.0'], ['transitive','2.0.0']]) {
  await mkdir('node_modules/'+name,{recursive:true});
  await writeFile('node_modules/'+name+'/package.json',JSON.stringify({version}));
  await new Promise(resolve=>setTimeout(resolve,150));
}
`,
    );
    await chmod(npm, 0o700);
    await writeFile(
      runner,
      `import { ensureDependencies } from ${JSON.stringify(new URL('../scripts/lib/dependencies.mjs', import.meta.url).href)};
await ensureDependencies({ root: ${JSON.stringify(root)}, npmCommand: ${JSON.stringify(npm)} });
console.log('ready');`,
    );
    const launches = await Promise.all([
      run(process.execPath, [runner]),
      run(process.execPath, [runner]),
    ]);
    for (const launch of launches) {
      assert.equal(launch.stdout.trim(), 'ready');
    }
    assert.equal((await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').length, 1);
    assert(launches.some(({ stderr }) => stderr.includes('npm diagnostic on stdout')));
    assert((await readFile(join(root, 'calls'), 'utf8')).includes('--ignore-scripts'));
    await rm(join(root, 'node_modules/transitive'), { recursive: true });
    await ensureDependencies({ root, npmCommand: npm });
    assert.equal((await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').length, 2);
    await rm(join(root, 'node_modules'), { recursive: true });
    await assert.rejects(
      run(process.execPath, [runner], { env: { ...process.env, INSTALL_TEST_FAIL: '1' } }),
    );
    await assert.rejects(readFile(join(root, '.install.lock/owner.json')), { code: 'ENOENT' });
    await mkdir(join(root, '.install.lock'));
    await writeFile(join(root, '.install.lock/owner.json'), JSON.stringify({ pid: 2147483647 }));
    await run(process.execPath, [runner]);
    assert.equal((await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
