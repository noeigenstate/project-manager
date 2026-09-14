import { createServer } from 'vite';
import { _electron } from 'playwright';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
const require = createRequire(import.meta.url);
const server = await createServer();
await server.listen();
let app;
try {
  const dataDir = path.resolve(`.test-output/dev-check-${Date.now()}`);
  await fs.mkdir(dataDir, { recursive: true });
  const env = { ...process.env, PROJECT_GRID_DEV_URL: 'http://127.0.0.1:5178', PROJECT_GRID_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: require('electron'), args: [process.cwd()], env });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '添加第一个项目', exact: true }).waitFor();
  await page.screenshot({ path: '.test-output/dev-empty.png' });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('PASS: Vite development mode and empty workspace render without page errors');
} finally {
  if (app) await app.close();
  await server.close();
}
