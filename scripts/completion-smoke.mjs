import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
const require = createRequire(import.meta.url), exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.test-output', `completion-${Date.now()}`), dataDir = path.join(output, 'profile');
const home = path.join(output, 'codex-home'), bin = path.join(output, 'bin');
const project = { id: randomUUID(), name: 'Parent task status', path: path.join(output, 'project'), kind: 'local', restore: { terminal: false, codex: false } };
for (const directory of [dataDir, project.path, bin, path.join(home, 'sessions')]) await fs.mkdir(directory, { recursive: true });
await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${path.join(bin, 'codex.exe')}`, path.join(root, 'tests/fixtures/restore-codex.cs')], { windowsHide: true });
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { notifications: true, restoreSessions: false, closeToTray: false } }));
const env = { ...process.env, PROJECT_GRID_DATA_DIR: dataDir, CODEX_HOME: home }; delete env.ELECTRON_RUN_AS_NODE; delete env.PROJECT_GRID_DEV_URL;
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path'); env[pathKey] = bin + path.delimiter + env[pathKey];
const packaged = process.argv.includes('--packaged');
let application, page, bootstrap;
async function waitFor(check, label) { const until = Date.now() + 15000; while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 60)); } throw new Error(`Timed out: ${label}`); }
const state = async () => (await page.evaluate(() => window.projectGrid.getState())).value.projects[0];
const notices = () => application.evaluate(() => globalThis.completionNotices);
const input = data => page.evaluate(({ id, data }) => window.projectGrid.writeTerminal(id, data), { id: project.id, data });
const thread = randomUUID(), child = randomUUID();
const transcript = path.join(home, 'sessions', `rollout-${thread}.jsonl`);
const record = (type, turn) => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: turn } }) + '\n';
async function notify(id, turn) {
  await exec(bootstrap.powershellPath, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bootstrap.notifyPath, '-PipeName', bootstrap.pipeName, '-ProjectId', bootstrap.projectId, '-SessionKey', bootstrap.sessionKey, '-Payload', JSON.stringify({ type: 'agent-turn-complete', 'thread-id': id, 'turn-id': turn })], { windowsHide: true, timeout: 10000 });
}
async function launch() {
  application = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Project Grid.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env, timeout: 30000 });
  page = await application.firstWindow();
  await application.evaluate(({ Notification, dialog }) => {
    globalThis.completionNotices = 0; Notification.isSupported = () => true;
    Notification.prototype.show = function () { globalThis.completionNotices++; };
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await page.waitForSelector('.project-panel');
  await page.getByRole('button', { name: '启动终端', exact: true }).click();
  await waitFor(async () => (await state()).shellReady, 'shell ready');
  const runtime = (await fs.readdir(dataDir)).find(name => name.startsWith('runtime-'));
  bootstrap = JSON.parse(await fs.readFile(path.join(dataDir, runtime, `${(await state()).sessionId}.json`), 'utf8'));
  await page.getByRole('button', { name: '启动 Codex', exact: true }).click();
  await waitFor(async () => (await state()).codexActive, 'offline Codex fixture');
}
try {
  await launch();
  await notify(child, 'before-input'); assert.equal(await notices(), 0);
  await input('first instruction\r');
  await fs.writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd: project.path, source: 'cli' } }) + '\n' + record('task_started', 'first'));
  await fs.writeFile(path.join(home, 'sessions', `rollout-${child}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: child, cwd: project.path, source: { subagent: thread } } }) + '\n' + record('task_started', 'child-turn') + record('task_complete', 'child-turn'));
  await notify(child, 'child-turn');
  await waitFor(async () => (await state()).codexActivity === 'working', 'parent stays running');
  assert.equal(await notices(), 0); assert.equal((await state()).unread, 0);
  await waitFor(async () => page.locator('.status-badge').innerText().then(text => text.includes('正在处理')), 'visible running badge');
  await page.screenshot({ path: path.join(output, 'parent-running.png') });
  await fs.appendFile(transcript, record('task_complete', 'first')); await notify(thread, 'first');
  await waitFor(async () => (await state()).unread === 1, 'parent completes');
  assert.equal(await notices(), 1);
  await page.evaluate(id => window.projectGrid.acknowledge(id), project.id);
  await input('draft'); await notify(child, 'new-id'); await notify(thread, 'first');
  assert.equal(await notices(), 1); assert.equal((await state()).codexActivity, 'complete');
  await input('\x15'); await input('second instruction\r');
  await fs.appendFile(transcript, record('task_started', 'second'));
  await notify(thread, 'first');
  assert.equal((await state()).codexActivity, 'working'); assert.equal(await notices(), 1);
  await fs.appendFile(transcript, record('task_complete', 'first'));
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal((await state()).codexActivity, 'working');
  await fs.appendFile(transcript, record('task_complete', 'second')); await notify(thread, 'second');
  await waitFor(async () => (await state()).unread === 1, 'second parent turn completes');
  assert.equal(await notices(), 2);
  await notify(child, 'yet-another-turn'); await notify(thread, 'second');
  assert.equal(await notices(), 2);
  await fs.appendFile(transcript, record('task_started', 'interrupted') + record('turn_aborted', 'interrupted'));
  await waitFor(async () => (await state()).codexActivity === 'interrupted', 'interruption is distinct from completion');
  assert.equal(await notices(), 2);
  console.log('PASS: real parent lifecycle owns working/completed/interrupted status; child and stale callbacks never finish the current task');
  await application.close(); application = null;
  await launch(); await notify(child, 'after-restart');
  assert.equal(await notices(), 0);
  assert.notEqual((await state()).codexActivity, 'complete', 'old lastCompletedAt is not the current running state');
  console.log('PASS: completed history and restarting never generate a new completion notice');
  console.log(`Fixture: ${output}`);
} finally { if (application) await application.close(); }
