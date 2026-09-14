import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const dev = process.argv.includes('--dev');
let server;
if (dev) {
  const { createServer } = await import('vite');
  server = await createServer({ root });
  await server.listen();
  env.PROJECT_GRID_DEV_URL = 'http://127.0.0.1:5178';
} else {
  const build = spawnSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const child = spawn(require('electron'), [root], { cwd: root, env, stdio: 'inherit', windowsHide: false });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; server?.close(); });
child.on('exit', async (code) => { await server?.close(); process.exit(code ?? 0); });
