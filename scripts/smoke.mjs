import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import net from 'node:net';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.test-output', `desktop-${Date.now()}`);
const dataDir = path.join(output, 'user-data');
await fs.mkdir(dataDir, { recursive: true });
const names = ['界面开发', '服务接口', '验证任务', "中文 空格 [a] 'b' $c", '数据处理', '工具项目'];
const projects = [];
for (const name of names) {
  const folder = path.join(output, 'projects', name);
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(path.join(folder, 'src', 'components'), { recursive: true });
  await fs.mkdir(path.join(folder, 'assets'));
  await fs.writeFile(path.join(folder, 'README.md'), '# Project Grid fixture\n\n目录预览验证\n<script>globalThis.fileCodeRan = true</script>\n');
  await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: 'fixture', private: true }, null, 2));
  await fs.writeFile(path.join(folder, '.gitignore'), 'node_modules\n');
  await fs.writeFile(path.join(folder, 'src', 'main.ts'), 'export const message = "中文文件预览";\n');
  await fs.writeFile(path.join(folder, 'src', 'components', 'panel.tsx'), 'export const Panel = () => "hello";\n');
  projects.push({ id: randomUUID(), name, path: folder, unread: 0, done: false, seenEvents: [], lastCompletedAt: null });
}
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 1, projects, settings: { columns: 3, notifications: false, sound: false, closeToTray: true, fontSize: 12 } }));
const env = { ...process.env, PROJECT_GRID_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PROJECT_GRID_DEV_URL;
let application;
const packaged = process.argv.includes('--packaged');
const errors = [];
async function waitFor(fn, message, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${message}`);
}
try {
  application = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Project Grid.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env, timeout: 30000 });
  application.process().stderr.on('data', data => { const text = data.toString(); if (/Uncaught|Error:|failed to load/i.test(text)) errors.push(text); });
  const page = await application.firstWindow();
  await application.evaluate(({ ipcMain }) => {
    globalThis.terminalTestInputs = [];
    ipcMain.on('terminal:write', (_event, id, data) => {
      globalThis.terminalTestInputs.push({ id, data });
      if (globalThis.terminalTestInputs.length > 40) globalThis.terminalTestInputs.shift();
    });
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('.project-panel', { timeout: 20000 });
  assert.equal(await page.locator('.project-panel').count(), 6);
  assert.equal(await page.locator('aside').count(), 0, 'overview has no sidebar');
  const material = await page.locator('.project-panel').first().evaluate(el => ({ filter: getComputedStyle(el).backdropFilter, reduced: matchMedia('(prefers-reduced-transparency: reduce)').matches, background: getComputedStyle(el).backgroundColor }));
  console.log('Glass material:', JSON.stringify(material));
  assert.ok(material.filter.includes('blur') || material.reduced);
  console.log('PASS: desktop loads six real project folders');

  for (const [index, project] of projects.entries()) {
    const projectPanel = page.locator(`[data-project-id="${project.id}"]`);
    if (index === 0) await projectPanel.getByRole('button', { name: `全屏查看 ${project.name}`, exact: true }).click();
    assert.equal(await projectPanel.locator('.terminal-host').count(), 0, 'no empty terminal layer may intercept the start button');
    const startButton = projectPanel.getByRole('button', { name: '启动终端', exact: true });
    assert.ok(await startButton.evaluate(button => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit === button || button.contains(hit);
    }), 'the actual start button must receive pointer input');
    await startButton.click();
    if (index === 0) await page.getByRole('button', { name: '返回总览', exact: true }).click();
  }
  await waitFor(async () => {
    const result = await page.evaluate(() => window.projectGrid.getState());
    return result.ok && result.value.projects.every(p => p.status === 'shell' && p.shellReady);
  }, 'six PowerShell terminals ready');
  console.log('PASS: real button clicks start six ConPTY terminals in grid and fullscreen views');

  await page.evaluate(id => window.projectGrid.writeTerminal(id, '\x1b[1;1R'), projects[0].id);
  const readyAfterReport = (await page.evaluate(() => window.projectGrid.getState())).value.projects[0].shellReady;
  assert.equal(readyAfterReport, true, 'automatic terminal replies must not disable the Codex start button');

  await page.evaluate(id => window.projectGrid.writeTerminal(id, "[IO.File]::WriteAllText((Join-Path (Get-Location).Path 'cwd-proof.txt'), (Get-Location).Path)\r"), projects[3].id);
  await waitFor(async () => { try { return await fs.readFile(path.join(projects[3].path, 'cwd-proof.txt'), 'utf8') === projects[3].path; } catch { return false; } }, 'literal working directory with brackets, quotes, ampersand and dollar');

  await page.evaluate(id => window.projectGrid.writeTerminal(id, "Write-Output 'PROJECT_GRID_STREAM_OK'\r"), projects[0].id);
  await waitFor(async () => {
    const result = await page.evaluate(id => window.projectGrid.attachTerminal(id), projects[0].id);
    return result.ok && result.value.data.includes('PROJECT_GRID_STREAM_OK');
  }, 'terminal output');
  await page.evaluate(id => window.projectGrid.writeTerminal(id, 'codex --version\r'), projects[1].id);
  await waitFor(async () => {
    const result = await page.evaluate(id => window.projectGrid.attachTerminal(id), projects[1].id);
    return result.ok && result.value.data.includes('codex-cli');
  }, 'Codex wrapper returns version without a model request');
  await waitFor(async () => {
    const result = await page.evaluate(() => window.projectGrid.getState());
    return result.ok && result.value.projects[1].status === 'shell';
  }, 'Codex process exit returns to shell');
  assert.equal((await page.evaluate(() => window.projectGrid.getState())).value.projects[1].unread, 0);
  console.log('PASS: actual Codex CLI launches through the wrapper; command exit does not mean turn complete');
  await page.evaluate(id => window.projectGrid.writeTerminal(id, 'codex features list\r'), projects[1].id);
  await waitFor(async () => {
    const result = await page.evaluate(id => window.projectGrid.attachTerminal(id), projects[1].id);
    return result.ok && result.value.data.includes('stable');
  }, 'Codex parses notification config without losing Windows argument quotes');
  await waitFor(async () => (await page.evaluate(() => window.projectGrid.getState())).value.projects[1].shellReady, 'Codex config check returns prompt');
  assert.equal((await page.evaluate(() => window.projectGrid.getState())).value.projects[1].error, null);

  const runtime = (await fs.readdir(dataDir)).find(name => name.startsWith('runtime-'));
  const bootstraps = [];
  for (const filename of await fs.readdir(path.join(dataDir, runtime))) bootstraps.push(JSON.parse(await fs.readFile(path.join(dataDir, runtime, filename), 'utf8')));
  const info = bootstraps.find(b => b.projectId === projects[0].id);
  const complete = async (turnId, target = info) => {
    const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'smoke-thread', 'turn-id': turnId, cwd: projects[0].path, 'last-assistant-message': '验证完成 "quotes" 中文' });
    await exec(target.powershellPath, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', target.notifyPath, '-PipeName', target.pipeName, '-ProjectId', target.projectId, '-SessionKey', target.sessionKey, '-Payload', payload], { windowsHide: true, timeout: 12000 });
  };
  await complete('turn-1');
  await waitFor(async () => (await page.evaluate(() => window.projectGrid.getState())).value.projects[0].unread === 1, 'real notify.ps1 marks red');
  await complete('turn-1');
  assert.equal((await page.evaluate(() => window.projectGrid.getState())).value.projects[0].unread, 1);
  const animation = await page.locator(`[data-project-id="${projects[0].id}"]`).evaluate(el => getComputedStyle(el).animationName);
  assert.equal(animation, 'attention-border');
  console.log('PASS: real PowerShell notify -> authenticated local pipe -> red blinking panel, duplicates ignored');

  const panel = page.locator(`[data-project-id="${projects[0].id}"]`);
  const sessionBefore = (await page.evaluate(() => window.projectGrid.getState())).value.projects[0].sessionId;
  await panel.getByRole('button', { name: `查看 ${projects[0].name} 的完成结果` }).click();
  await page.waitForSelector('.focus-mode');
  await waitFor(async () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), 'native fullscreen');
  assert.equal((await page.evaluate(() => window.projectGrid.getState())).value.projects[0].unread, 0);
  await page.getByRole('treeitem', { name: 'src', exact: true }).waitFor();
  assert.equal(await page.locator('.focus-toolbar').count(), 0, 'old top toolbar removed');
  assert.equal(await page.locator('.focus-sidebar').getByRole('button', { name: '返回总览', exact: true }).count(), 1);
  await page.getByRole('treeitem', { name: 'src', exact: true }).click();
  await page.getByRole('treeitem', { name: 'components', exact: true }).click();
  await page.getByRole('treeitem', { name: 'panel.tsx', exact: true }).waitFor();
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await page.getByLabel('文件文本内容', { exact: true }).waitFor();
  assert.ok((await page.getByLabel('文件文本内容', { exact: true }).innerText()).includes('目录预览验证'));
  assert.equal(await page.evaluate(() => globalThis.fileCodeRan), undefined, 'file markup is displayed as text');
  assert.equal((await page.evaluate(() => window.projectGrid.getState())).value.projects[0].sessionId, sessionBefore);
  await page.screenshot({ path: path.join(output, 'file-preview.png') });
  await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
  const fullWidth = (await panel.boundingBox()).width;
  await page.getByRole('button', { name: '收起目录栏', exact: true }).click();
  await waitFor(async () => (await panel.boundingBox()).width > fullWidth + 100, 'collapsed sidebar frees terminal width');
  await page.screenshot({ path: path.join(output, 'collapsed-sidebar.png') });
  assert.ok(await page.getByRole('button', { name: '返回总览', exact: true }).isVisible());
  assert.ok(await page.getByRole('button', { name: '标记开发完成', exact: true }).isVisible());
  await page.keyboard.press('Control+b');
  await page.getByRole('treeitem', { name: 'panel.tsx', exact: true }).waitFor();
  await page.getByRole('button', { name: '折叠所有文件夹', exact: true }).click();
  await waitFor(async () => await page.getByRole('treeitem', { name: 'src', exact: true }).getAttribute('aria-expanded') === 'false', 'collapse nested folders');
  await fs.writeFile(path.join(projects[0].path, 'new-file.txt'), 'directory refresh');
  await page.getByRole('button', { name: '刷新项目目录', exact: true }).click();
  await page.getByRole('treeitem', { name: 'new-file.txt', exact: true }).waitFor();
  await fs.writeFile(path.join(projects[0].path, 'auto-refresh.txt'), 'automatic directory refresh');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await page.getByRole('treeitem', { name: 'auto-refresh.txt', exact: true }).waitFor({ timeout: 7000 });
  assert.equal((await page.evaluate(() => window.projectGrid.getState())).value.projects[0].sessionId, sessionBefore);
  console.log('PASS: focused explorer, nested folders, safe file preview, refresh, collapse and Ctrl+B preserve the terminal session');
  await page.screenshot({ path: path.join(output, 'fullscreen.png') });
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await waitFor(async () => !await page.locator('.focus-mode').count(), 'back to grid');
  assert.equal((await page.evaluate(() => window.projectGrid.getState())).value.projects[0].sessionId, sessionBefore);
  await complete('turn-2');
  await waitFor(async () => (await page.evaluate(() => window.projectGrid.getState())).value.projects[0].unread === 1, 'second round red');
  console.log('PASS: red tile opens native fullscreen, marks viewed, returns without restarting terminal, and next turn lights red');

  await panel.getByRole('button', { name: `查看 ${projects[0].name} 的完成结果` }).click();
  await page.getByRole('button', { name: '标记开发完成', exact: true }).click();
  await waitFor(async () => !await page.locator('.focus-mode').count(), 'finish returns to grid');
  await waitFor(async () => panel.getAttribute('data-status').then(s => s === 'done'), 'green complete status');
  assert.equal(await panel.evaluate(el => getComputedStyle(el).animationName), 'none');
  console.log('PASS: manually completing a project makes a persistent green, non-blinking panel');

  const target = bootstraps.find(b => b.projectId === projects[2].id);
  await complete('other-project-turn', target);
  await page.getByRole('button', { name: '4 列布局', exact: true }).click();
  await page.getByRole('button', { name: '3 列布局', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索项目' }).fill('不存在');
  await page.waitForSelector('.no-results');
  await page.getByRole('button', { name: '清除搜索' }).click();
  await page.waitForSelector('.project-panel');
  await page.screenshot({ path: path.join(output, 'grid.png') });
  await page.getByRole('button', { name: /设置/ }).click();
  await page.waitForSelector('dialog[open]');
  await page.screenshot({ path: path.join(output, 'settings.png') });
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 640));
  await page.screenshot({ path: path.join(output, 'compact.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false);
  await page.getByRole('button', { name: `${projects[0].name} 的更多操作`, exact: true }).click();
  await page.getByRole('menuitem', { name: '继续开发', exact: true }).click();
  await waitFor(async () => (await page.evaluate(() => window.projectGrid.getState())).value.projects[0].done === false, 'project menu reopens development');
  await page.evaluate(id => window.projectGrid.markDone(id, true), projects[0].id);
  console.log('PASS: grid layout, filtering, settings, and compact window');

  // A spoofed or stale session key cannot light an unrelated project's tile.
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(`\\\\.\\pipe\\${info.pipeName}`);
    socket.on('connect', () => socket.end(JSON.stringify({ projectId: projects[1].id, sessionKey: 'wrong', type: 'turn-complete', eventId: 'spoof' }) + '\n'));
    socket.on('close', resolve); socket.on('error', reject);
  });
  assert.equal((await page.evaluate(() => window.projectGrid.getState())).value.projects[1].unread, 0);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'workspace.json'), 'utf8'));
  assert.equal(saved.projects[0].done, true);
  assert.equal(saved.projects[2].unread, 1);
  assert.deepEqual(errors, []);
  console.log('PASS: persisted green/red states and rejected wrong-session events');
  console.log(`Screenshots: ${output}`);
} catch (error) {
  console.error(error);
  if (errors.length) console.error(errors.join('\n'));
  if (application) {
    try {
      const page = await application.firstWindow();
      console.error('Desktop state:', JSON.stringify(await page.evaluate(() => window.projectGrid.getState())));
      console.error('Test terminal input:', JSON.stringify(await application.evaluate(() => globalThis.terminalTestInputs)));
      await page.screenshot({ path: path.join(output, 'failure.png') });
    } catch {}
  }
  process.exitCode = 1;
} finally {
  if (application) await application.close();
}
