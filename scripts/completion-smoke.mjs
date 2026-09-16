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
const project = { id: randomUUID(), name: '完成提醒验证', path: path.join(output, 'project'), kind: 'local', restore: { terminal: false, codex: false } };
await fs.mkdir(dataDir, { recursive: true }); await fs.mkdir(project.path);
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { notifications: true, restoreSessions: false, closeToTray: false } }));
const env = { ...process.env, PROJECT_GRID_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE; delete env.PROJECT_GRID_DEV_URL;
const packaged = process.argv.includes('--packaged');
let application, page, bootstrap;
async function waitFor(check, description) { const until = Date.now() + 15000; while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 60)); } throw new Error(`Timed out: ${description}`); }
const state = async () => (await page.evaluate(() => window.projectGrid.getState())).value.projects[0];
const notices = () => application.evaluate(() => globalThis.completionNotices);
const input = data => page.evaluate(({ id, data }) => window.projectGrid.writeTerminal(id, data), { id: project.id, data });
async function launch() {
  application = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Project Grid.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env, timeout: 30000 });
  page = await application.firstWindow();
  await application.evaluate(({ Notification, BrowserWindow }) => {
    globalThis.completionNotices = 0;
    Notification.isSupported = () => true;
    Notification.prototype.show = function () { globalThis.completionNotices++; };
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
  });
  await page.waitForSelector('.project-panel');
  await page.evaluate(id => window.projectGrid.startTerminal(id), project.id);
  await waitFor(async () => (await state()).shellReady, 'test shell');
  const runtime = (await fs.readdir(dataDir)).find(name => name.startsWith('runtime-'));
  bootstrap = JSON.parse(await fs.readFile(path.join(dataDir, runtime, `${(await state()).sessionId}.json`), 'utf8'));
}
async function complete(thread, turn) {
  await exec(bootstrap.powershellPath, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bootstrap.notifyPath, '-PipeName', bootstrap.pipeName, '-ProjectId', bootstrap.projectId, '-SessionKey', bootstrap.sessionKey, '-Payload', JSON.stringify({ type: 'agent-turn-complete', 'thread-id': thread, 'turn-id': turn })], { windowsHide: true, timeout: 10000 });
  await waitFor(async () => JSON.parse(await fs.readFile(path.join(dataDir, 'workspace.json'), 'utf8')).projects[0].seenEvents.includes(`${thread}:${turn}`), 'completion callback received');
}
async function close() {
  if (!application) return;
  await application.close(); application = null;
}
try {
  await launch();
  await complete('background', 'before-any-input');
  assert.equal(await notices(), 0);
  await input("Write-Output 'USER_INSTRUCTION'\r");
  await waitFor(async () => (await state()).shellReady, 'submitted instruction');
  await complete('main', 'first');
  const completedAt = (await state()).lastCompletedAt;
  assert.equal(await notices(), 1); assert.equal((await state()).unread, 1);
  await complete('new-background-thread', 'new-turn');
  await complete('main', 'another-id-without-input');
  await input('\x1b[I\x1b[O\x1b[1;1R'); await input('\r');
  await complete('focus-refresh', 'different-id');
  assert.equal(await notices(), 1); assert.equal((await state()).lastCompletedAt, completedAt);
  await page.evaluate(id => window.projectGrid.acknowledge(id), project.id);
  await input('draft-not-submitted'); await complete('draft', 'still-idle');
  assert.equal(await notices(), 1); assert.equal((await state()).unread, 0);
  await input('\x03');
  await input("Write-Output 'NEXT_USER_INSTRUCTION'\r");
  await waitFor(async () => (await state()).shellReady, 'second submitted instruction');
  await complete('main', 'second');
  assert.equal(await notices(), 2); assert.equal((await state()).unread, 1);
  await complete('background', 'after-second'); assert.equal(await notices(), 2);
  console.log('PASS: actual notify hooks show one notification per submission; changed IDs, focus reports, empty Enter, acknowledgment and drafts stay quiet');
  await close();
  await launch(); await complete('background', 'after-app-restart');
  assert.equal(await notices(), 0); assert.equal((await state()).unread, 1);
  console.log('PASS: restarting and opening an idle terminal do not rearm a completed round');
  console.log(`Fixture: ${output}`);
} finally { if (application) await close(); }
