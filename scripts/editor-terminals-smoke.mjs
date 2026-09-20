import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url), exec = promisify(execFile);
const { createSSHFixture } = require('../tests/helpers/ssh-fixture.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.test-output', `editor-terminals-${Date.now()}`);
const dataDir = path.join(output, 'profile'), codexHome = path.join(output, 'codex-home'), bin = path.join(output, 'bin');
const project = { id: randomUUID(), name: '编辑与分屏验证', path: path.join(output, 'project'), kind: 'local', restore: { terminal: false, codex: false } };
const ssh = await createSSHFixture({ nativeWorker: false });
await fs.writeFile(path.join(ssh.project, 'remote.txt'), 'remote original');
for (const folder of [dataDir, bin, codexHome, path.join(project.path, 'src')]) await fs.mkdir(folder, { recursive: true });
await fs.writeFile(path.join(project.path, 'src', 'main.txt'), 'original\r\n中文\r\n');
await fs.writeFile(path.join(project.path, 'other.txt'), 'other');
await fs.writeFile(path.join(project.path, 'page.html'), '<h1>Original page</h1>');
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { notifications: false, restoreSessions: true, closeToTray: false } }));
await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${path.join(bin, 'codex.exe')}`, path.join(root, 'tests/fixtures/multi-codex.cs')], { windowsHide: true });
const env = { ...process.env, PROJECT_GRID_DATA_DIR: dataDir, PROJECT_GRID_TEST_RESTORE: '1', PROJECT_GRID_TEST_SSH_CONFIG: ssh.configFile, CODEX_HOME: codexHome };
delete env.ELECTRON_RUN_AS_NODE; delete env.PROJECT_GRID_DEV_URL;
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path'); env[pathKey] = bin + path.delimiter + env[pathKey];
const packaged = process.argv.includes('--packaged');
let application, page, clipboardOwner = null;
async function waitFor(check, name) { const until = Date.now() + 20000; while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 60)); } throw new Error(`Timed out: ${name}`); }
const state = async () => (await page.evaluate(() => window.projectGrid.getState())).value.projects[0];
const record = (type, turn) => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: turn } }) + '\n';
async function launch() {
  application = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Project Grid.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env });
  page = await application.firstWindow();
  await application.evaluate(async ({ clipboard, ClipboardItem }) => { globalThis.clipboardBackup = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))))); });
  await application.evaluate(({ dialog }) => { globalThis.editorResponses = []; dialog.showMessageBox = async (_window, options) => ({ response: options.title === '未保存的修改' ? globalThis.editorResponses.shift() ?? 2 : 1 }); });
  await page.waitForSelector('.project-panel');
}
async function answer(value) { await application.evaluate((_electron, value) => globalThis.editorResponses.push(value), value); }
async function readSaved() { return JSON.parse(await fs.readFile(path.join(dataDir, 'workspace.json'), 'utf8')).projects[0]; }
async function restoreClipboard() {
  if (!application || clipboardOwner === null) return;
  await application.evaluate(async ({ clipboard }, owner) => { if (await clipboard.readText() === owner) { if (globalThis.clipboardBackup?.length) await clipboard.write(globalThis.clipboardBackup); else clipboard.clear(); } }, clipboardOwner).catch(() => {});
  clipboardOwner = null;
}
try {
  await launch();
  await page.getByRole('button', { name: '启动终端', exact: true }).click();
  await waitFor(async () => (await state()).shellReady, 'first terminal');
  const primarySession = (await state()).sessionId;
  await page.getByRole('button', { name: `新增终端 ${project.name}`, exact: true }).click();
  await waitFor(async () => (await state()).terminals.length === 2 && (await state()).terminals.every(item => item.shellReady), 'two ready terminals');
  const ids = (await state()).terminals.map(item => item.id);
  assert.equal((await state()).terminals[0].sessionId, primarySession);
  for (const [index, id] of ids.entries()) {
    await page.locator(`[data-terminal-id="${id}"] .terminal-split-body`).click({ position: { x: 30, y: 60 } });
    await page.keyboard.type(`[IO.File]::WriteAllText('terminal-${index}.json', (@{Process=$PID;Value='INDEPENDENT_${index}'} | ConvertTo-Json -Compress))`);
    await page.keyboard.press('Enter');
  }
  await waitFor(async () => fs.access(path.join(project.path, 'terminal-1.json')).then(() => true, () => false), 'independent commands');
  await waitFor(async () => (await state()).terminals.every(item => item.shellReady), 'both commands return to their own prompts');
  const proofs = await Promise.all(ids.map((_id, index) => fs.readFile(path.join(project.path, `terminal-${index}.json`), 'utf8').then(JSON.parse)));
  assert.equal(proofs[0].Value, 'INDEPENDENT_0'); assert.equal(proofs[1].Value, 'INDEPENDENT_1');
  assert.ok(proofs.every(proof => Number.isInteger(proof.Process) && proof.Process > 0));
  assert.notEqual(proofs[0].Process, proofs[1].Process, 'each split must own a distinct native shell process');
  for (const [index, id] of ids.entries()) {
    const snapshot = await page.evaluate(id => window.projectGrid.attachTerminal(id), id);
    assert.equal(snapshot.value.sessionId, (await state()).terminals[index].sessionId);
    // Raw VT history may contain a prediction from shared PSReadLine history
    // that was erased before submission. Assert the final screen instead.
    const visible = (await page.locator(`[data-terminal-id="${id}"] .xterm-rows`).innerText()).replace(/\s/g, '');
    assert.ok(visible.includes(`INDEPENDENT_${index}`));
    assert.ok(!visible.includes(`INDEPENDENT_${1 - index}`));
  }
  await page.getByRole('button', { name: `全屏查看 ${project.name}`, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  assert.equal(await page.locator('.terminal-split').count(), 2);
  const boxes = await page.locator('.terminal-split').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
  assert.ok(boxes.every(box => box.width > 200 && box.height > 150));
  assert.ok(boxes[0].x + boxes[0].width <= boxes[1].x + 2 || boxes[0].y + boxes[0].height <= boxes[1].y + 2);
  await page.screenshot({ path: path.join(output, 'split-terminals.png') });

  await page.getByRole('treeitem', { name: 'src', exact: true }).click();
  await page.getByRole('treeitem', { name: 'main.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^复制绝对路径/ }).click();
  clipboardOwner = path.join(project.path, 'src', 'main.txt');
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), path.join(project.path, 'src', 'main.txt'));
  await page.getByRole('treeitem', { name: 'main.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制相对路径', exact: true }).click();
  clipboardOwner = 'src/main.txt';
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), 'src/main.txt');
  await page.getByRole('treeitem', { name: 'main.txt', exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文件编辑器', exact: true });
  await editor.fill('saved\n保留中文'); await page.keyboard.press('Control+s');
  await waitFor(async () => (await fs.readFile(path.join(project.path, 'src', 'main.txt'), 'utf8')) === 'saved\r\n保留中文', 'Ctrl+S saves with original CRLF');
  await editor.fill('unsaved draft');
  await answer(2); await page.getByRole('treeitem', { name: 'other.txt', exact: true }).click();
  assert.equal(await editor.inputValue(), 'unsaved draft');
  await answer(0); await page.getByRole('treeitem', { name: 'other.txt', exact: true }).click();
  await page.getByLabel('文件文本内容').waitFor();
  assert.equal(await fs.readFile(path.join(project.path, 'src', 'main.txt'), 'utf8'), 'unsaved draft');
  await page.getByRole('button', { name: '编辑', exact: true }).click(); await editor.fill('conflicting draft');
  await fs.writeFile(path.join(project.path, 'other.txt'), 'external update');
  await page.keyboard.press('Control+s');
  await page.getByText(/文件已被其他程序修改/).waitFor();
  assert.equal(await fs.readFile(path.join(project.path, 'other.txt'), 'utf8'), 'external update');
  await answer(1); await page.getByRole('treeitem', { name: 'page.html', exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await editor.fill('<h1>Edited HTML</h1>'); await page.keyboard.press('Control+s');
  await waitFor(async () => (await fs.readFile(path.join(project.path, 'page.html'), 'utf8')).includes('Edited HTML'), 'HTML source save');
  await page.getByRole('button', { name: '页面', exact: true }).click();
  await page.frameLocator('iframe.html-preview-frame').getByText('Edited HTML').waitFor();
  await page.getByRole('button', { name: '编辑', exact: true }).click(); await editor.fill('<h1>Draft</h1>');
  await page.screenshot({ path: path.join(output, 'file-editor.png') });
  await answer(2); const canceled = await page.evaluate(() => window.projectGrid.quit()); assert.equal(canceled.value, false);
  await answer(1); await page.getByRole('button', { name: '返回终端', exact: true }).click();
  await waitFor(async () => (await state()).terminals.every(item => item.shellReady), 'shells still ready after editing');
  console.log('PASS: path copy, text/HTML edits, Ctrl+S, unsaved navigation/quit and save-conflict protection');

  for (const id of ids) await page.locator(`[data-terminal-id="${id}"]`).getByRole('button', { name: '启动 Codex', exact: true }).click();
  await waitFor(async () => { const saved = await readSaved(); return !!saved.restore.threadId && !!saved.terminals[0].restore.threadId; }, 'distinct native terminal titles');
  const saved = await readSaved(), threads = [saved.restore.threadId, saved.terminals[0].restore.threadId];
  assert.notEqual(threads[0], threads[1]);
  await fs.appendFile(path.join(codexHome, 'sessions', `rollout-${threads[0]}.jsonl`), record('task_started', 'left-working'));
  await fs.appendFile(path.join(codexHome, 'sessions', `rollout-${threads[1]}.jsonl`), record('task_started', 'right-done') + record('task_complete', 'right-done'));
  await waitFor(async () => { const value = await state(); return value.terminals[0].codexActivity === 'working' && value.terminals[1].codexActivity === 'complete'; }, 'independent Codex status');
  assert.equal((await state()).codexActivity, 'working');
  await restoreClipboard(); await application.close(); application = null;
  await launch();
  await waitFor(async () => (await state()).terminals.length === 2 && (await state()).terminals.every(item => item.codexActive), 'both terminals restored');
  for (const thread of threads) {
    await waitFor(async () => { const receipt = JSON.parse(await fs.readFile(path.join(codexHome, 'sessions', `${thread}-receipt.json`), 'utf8')); return receipt.args.includes('resume') && receipt.args.includes(thread); }, 'exact conversation resumed');
  }
  const secondSession = (await state()).terminals[1].sessionId;
  await page.getByRole('button', { name: `关闭 ${project.name} 终端 1`, exact: true }).click();
  await waitFor(async () => (await state()).terminals.length === 1, 'close one split');
  assert.equal((await state()).terminals[0].sessionId, secondSession);
  assert.equal((await state()).terminals[0].codexActive, true);
  console.log('PASS: independent terminals, automatic splits, exact Codex recovery and closing one without restarting its neighbor');
  const remoteId = (await page.evaluate(() => window.projectGrid.addSSHProject({ host: 'fixture', path: '/srv/fixture', name: 'SSH 分屏验证' }))).value;
  const remoteState = async () => (await page.evaluate(() => window.projectGrid.getState())).value.projects.find(item => item.id === remoteId);
  await waitFor(async () => (await remoteState()).shellReady, 'SSH terminal ready');
  await page.getByRole('button', { name: '新增终端 SSH 分屏验证', exact: true }).click();
  await waitFor(async () => (await remoteState()).terminals.length === 2 && (await remoteState()).terminals.every(item => item.shellReady), 'two independent SSH terminals');
  const remoteSecond = (await remoteState()).terminals[1].sessionId;
  await page.getByRole('button', { name: '全屏查看 SSH 分屏验证', exact: true }).click();
  await page.getByRole('treeitem', { name: 'remote.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^复制绝对路径/ }).click(); clipboardOwner = '/srv/fixture/remote.txt';
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), clipboardOwner);
  await page.getByRole('treeitem', { name: 'remote.txt', exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('textbox', { name: '文件编辑器', exact: true }).fill('saved over SSH\n远程编辑'); await page.keyboard.press('Control+s');
  await waitFor(async () => (await fs.readFile(path.join(ssh.project, 'remote.txt'), 'utf8')).includes('远程编辑'), 'SSH editor save');
  await page.getByRole('button', { name: '返回终端', exact: true }).click();
  await page.getByRole('button', { name: '关闭 SSH 分屏验证 终端 1', exact: true }).click();
  await waitFor(async () => (await remoteState()).terminals.length === 1, 'one SSH terminal closes');
  assert.equal((await remoteState()).terminals[0].sessionId, remoteSecond);
  assert.equal((await page.evaluate(id => window.projectGrid.readFile(id, 'remote.txt'), remoteId)).value.content, 'saved over SSH\n远程编辑');
  console.log('PASS: SSH split terminals, Linux absolute paths, editing and file access after closing the first connection');
  console.log(`Screenshots: ${output}`);
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); console.error(`Failure screenshot: ${output}`); }
  throw error;
} finally { if (application) { await restoreClipboard(); await application.close(); } await ssh.close(); }
