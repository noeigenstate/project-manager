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
const { fileClipboard } = require('../electron/file-clipboard.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.test-output', `workspace-${Date.now()}`), dataDir = path.join(output, 'profile');
const project = { id: randomUUID(), name: '文件与语音', path: path.join(output, 'project'), kind: 'local', restore: { terminal: false, codex: false } };
await fs.mkdir(project.path, { recursive: true }); await fs.mkdir(dataDir); await fs.mkdir(path.join(output, 'external'));
await fs.writeFile(path.join(project.path, 'source.txt'), 'FILE_CLIPBOARD_CONTENT');
await fs.writeFile(path.join(project.path, 'microphone-check.html'), '<button id="check">Check microphone</button><output id="result"></output><script>document.querySelector("#check").onclick=async()=>{try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});stream.getTracks().forEach(track=>track.stop());document.querySelector("#result").textContent="ALLOWED"}catch{document.querySelector("#result").textContent="BLOCKED"}}</script>');
await fs.writeFile(path.join(output, 'external', 'external.txt'), 'PASTE_IN_CONTENT');
await fs.mkdir(path.join(output, 'external', '外部文件夹'));
await fs.writeFile(path.join(output, 'external', '外部文件夹', 'nested.txt'), 'NESTED_PASTE_CONTENT');
await fs.mkdir(path.join(project.path, '目标目录'));
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { notifications: false, closeToTray: false } }));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const speech = path.join(output, 'speech.wav');
try { await exec(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/voice-fixture.ps1'), '-Destination', speech], { windowsHide: true }); }
catch (error) {
  if (process.argv.includes('--voice-assets')) throw error;
  const { wavFromSamples } = require('../src/voice-audio.ts');
  const tone = Float32Array.from({ length: 16000 * 5 }, (_, index) => Math.sin(index * Math.PI * 880 / 16000) * .08);
  await fs.writeFile(speech, Buffer.from(wavFromSamples(tone)));
  console.log('UI-only test uses a generated tone because system speech synthesis is unavailable.');
}
const assetIndex = process.argv.indexOf('--voice-assets');
const assets = assetIndex >= 0 ? path.resolve(process.argv[assetIndex + 1]) : null;
if (assets) {
  await fs.mkdir(path.join(dataDir, 'voice'));
  await fs.cp(path.join(assets, 'runtime'), path.join(dataDir, 'voice/runtime'), { recursive: true });
  await fs.copyFile(path.join(assets, 'ggml-base-q5_1.bin'), path.join(dataDir, 'voice/model.bin'));
}
const packaged = process.argv.includes('--packaged');
const env = { ...process.env, PROJECT_GRID_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE; delete env.PROJECT_GRID_DEV_URL;
let application, page;
async function waitFor(fn, label, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 80)); } throw new Error(`Timed out: ${label}`); }
async function filesFinished() { await waitFor(async () => { const result = await page.evaluate(() => window.projectGrid.getFileProgress()); return result.ok && result.value === null; }, 'all files in the paste operation finish'); }
async function backupClipboard() { await application.evaluate(async ({ clipboard, ClipboardItem }) => { globalThis.clipboardBackup = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))))); }); }
async function ownClipboard() { await application.evaluate(async ({ clipboard }) => { globalThis.clipboardOwnedText = await clipboard.readText(); }); }
async function restoreClipboard() { if (!application) return; await application.evaluate(async ({ clipboard }) => { if (globalThis.clipboardBackup && await clipboard.readText() === globalThis.clipboardOwnedText) { if (globalThis.clipboardBackup.length) await clipboard.write(globalThis.clipboardBackup); else clipboard.clear(); } globalThis.clipboardBackup = null; }).catch(() => {}); }
try {
  application = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Project Grid.exe') : require('electron'), args: [...(packaged ? [] : [root]), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${speech}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: root, env, timeout: 30000 });
  page = await application.firstWindow();
  if (process.argv.includes('--slow-copy')) await application.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get('project:directory');
    let delayed = false, active = 0;
    globalThis.directoryPeakRequests = 0;
    ipcMain.removeHandler('project:directory');
    ipcMain.handle('project:directory', async (event, ...args) => {
      active++; globalThis.directoryPeakRequests = Math.max(globalThis.directoryPeakRequests, active);
      try {
        if (!delayed) { delayed = true; await new Promise(resolve => setTimeout(resolve, 4200)); }
        return await handler(event, ...args);
      } finally { active--; }
    });
  });
  await application.evaluate(({ dialog, ipcMain, BrowserWindow }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
    globalThis.voicePastes = [];
    ipcMain.on('terminal:write', (_event, id, data) => globalThis.voicePastes.push({ id, data }));
  });
  if (process.argv.includes('--slow-copy')) await application.evaluate((_, fixtureRoot) => {
    const filesystem = process.mainModule.require('node:fs/promises');
    const copy = filesystem.cp;
    filesystem.cp = async (source, ...rest) => {
      if (String(source).startsWith(fixtureRoot) && String(source).endsWith('外部文件夹')) await new Promise(resolve => setTimeout(resolve, 700));
      return copy(source, ...rest);
    };
  }, output);
  if (!assets) await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('voice:state'); ipcMain.handle('voice:state', () => ({ ok: true, value: { phase: 'ready', ready: true, percent: 100, model: 'test stub', error: null } }));
    ipcMain.removeHandler('voice:transcribe'); ipcMain.handle('voice:transcribe', (_event, audio) => { if (audio.byteLength < 16000) return { ok: false, error: 'Missing recorded microphone samples' }; return { ok: true, value: 'Please open the project folder and continue the task.' }; });
  });
  await page.getByRole('button', { name: '启动终端', exact: true }).click();
  await waitFor(async () => (await page.evaluate(() => window.projectGrid.getState())).value.projects[0].shellReady, 'terminal ready');
  await page.getByRole('button', { name: `全屏查看 ${project.name}`, exact: true }).click();
  await page.getByRole('treeitem', { name: 'source.txt', exact: true }).waitFor();
  if (process.argv.includes('--slow-copy')) {
    assert.equal(await application.evaluate(() => globalThis.directoryPeakRequests), 1, 'automatic refresh must not overlap or discard a slow directory read');
    console.log('PASS: a directory read slower than the refresh interval still renders, with one request in flight');
  }
  assert.equal(await page.locator('.explorer-project').count(), 0);
  assert.equal(await page.locator('.explorer-path').getAttribute('title'), project.path);
  await page.getByRole('button', { name: '新建文件', exact: true }).click();
  await page.getByLabel('文件或文件夹名称', { exact: true }).fill('新文件.txt'); await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('treeitem', { name: '新文件.txt', exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project.path, '新文件.txt'), 'utf8'), '');
  await page.getByRole('treeitem', { name: '新文件.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^重命名/ }).click();
  const renameDialog = page.locator('dialog.file-edit-dialog[open]');
  await renameDialog.getByLabel('文件或文件夹名称', { exact: true }).fill('renamed.txt'); await renameDialog.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('treeitem', { name: 'renamed.txt', exact: true }).waitFor();
  await backupClipboard();
  await page.getByRole('treeitem', { name: 'source.txt', exact: true }).click(); await page.keyboard.press('Control+c');
  const copied = await fs.realpath(path.join(project.path, 'source.txt'));
  await waitFor(async () => { const entries = await fileClipboard(path.join(root, 'integration'), 'read'); return entries.length === 1 && entries[0] === copied; }, 'native Windows file clipboard');
  await ownClipboard();
  await exec(powershell, ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/paste-files-fixture.ps1'), '-Destination', path.join(output, 'external'), '-Expected', copied], { windowsHide: true });
  await waitFor(async () => { try { return await fs.readFile(path.join(output, 'external/source.txt'), 'utf8') === 'FILE_CLIPBOARD_CONTENT'; } catch { return false; } }, 'Explorer pastes the copied file outside the project');
  await fileClipboard(path.join(root, 'integration'), 'copy', [path.join(output, 'external/external.txt')]); await ownClipboard();
  await page.getByRole('treeitem', { name: project.name, exact: true }).click(); await page.keyboard.press('Control+v');
  await page.getByRole('treeitem', { name: 'external.txt', exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project.path, 'external.txt'), 'utf8'), 'PASTE_IN_CONTENT');
  await fileClipboard(path.join(root, 'integration'), 'copy', [path.join(output, 'external/external.txt'), path.join(output, 'external/外部文件夹')]); await ownClipboard();
  const tree = page.getByRole('tree', { name: `${project.name} 的文件目录`, exact: true });
  const blank = { x: 35, y: (await tree.boundingBox()).height - 12 };
  await tree.click({ position: blank }); await page.keyboard.press('Control+v');
  await page.getByRole('treeitem', { name: '外部文件夹', exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project.path, '外部文件夹/nested.txt'), 'utf8'), 'NESTED_PASTE_CONTENT');
  assert.equal(await fs.readFile(path.join(project.path, 'external - 副本.txt'), 'utf8'), 'PASTE_IN_CONTENT');
  assert.equal(await fs.readFile(path.join(project.path, 'external.txt'), 'utf8'), 'PASTE_IN_CONTENT', 'paste preserves the existing file');
  await page.getByRole('treeitem', { name: '目标目录', exact: true }).click();
  await page.getByRole('button', { name: '粘贴文件', exact: true }).click();
  await waitFor(async () => { try { return await fs.readFile(path.join(project.path, '目标目录/外部文件夹/nested.txt'), 'utf8') === 'NESTED_PASTE_CONTENT'; } catch { return false; } }, 'toolbar pastes into the selected directory');
  await filesFinished();
  await tree.click({ position: blank, button: 'right' });
  await page.getByRole('menuitem', { name: /^粘贴/ }).click();
  await waitFor(async () => { try { return await fs.readFile(path.join(project.path, 'external - 副本 (2).txt'), 'utf8') === 'PASTE_IN_CONTENT'; } catch { return false; } }, 'blank-area menu pastes into project root');
  await filesFinished();
  await tree.click({ position: blank }); await page.keyboard.press('Shift+Insert');
  await waitFor(async () => { try { return await fs.readFile(path.join(project.path, 'external - 副本 (3).txt'), 'utf8') === 'PASTE_IN_CONTENT'; } catch { return false; } }, 'Shift+Insert pastes files into the focused explorer');
  await filesFinished();
  console.log('PASS: blank-area Ctrl+V and context menu, toolbar folder destination, multi-file/directory paste and safe duplicate names');
  await restoreClipboard();
  await page.getByRole('treeitem', { name: 'renamed.txt', exact: true }).click(); await page.keyboard.press('Delete');
  await waitFor(async () => { try { await fs.stat(path.join(project.path, 'renamed.txt')); return false; } catch { return true; } }, 'delete moves file out of project');
  await page.locator('[data-node-path="external.txt"]').click({ button: 'right' });
  await page.screenshot({ path: path.join(output, 'file-actions.png') });
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Escape');
  await page.getByRole('menu', { name: '文件操作', exact: true }).waitFor({ state: 'detached', timeout: 5000 });
  assert.equal(await tree.evaluate(element => element === document.activeElement), true, 'Escape closes the menu even without tree focus, then returns keyboard focus');
  await page.getByRole('treeitem', { name: 'microphone-check.html', exact: true }).click();
  const isolated = page.frameLocator('iframe[title="HTML 页面预览"]');
  await isolated.getByRole('button', { name: 'Check microphone' }).click(); await isolated.getByText('BLOCKED', { exact: true }).waitFor();
  console.log('PASS: compact explorer, create/rename/delete, native Explorer copy-out and clipboard paste-in');
  if (await page.getByRole('button', { name: '返回终端', exact: true }).count()) await page.getByRole('button', { name: '返回终端', exact: true }).click();
  await page.getByRole('button', { name: `语音输入 ${project.name}`, exact: true }).click();
  await page.getByRole('button', { name: '检测麦克风', exact: true }).click();
  await page.getByText('麦克风已连接，请说话查看音量', { exact: true }).waitFor();
  await page.getByRole('button', { name: '开始录音', exact: true }).click();
  await page.getByText('录音中 0:05', { exact: true }).waitFor();
  await page.getByRole('button', { name: '停止并识别', exact: true }).click();
  await waitFor(async () => /project folder/i.test(await page.getByLabel('识别文字', { exact: true }).inputValue()), 'offline dictation result', 60000);
  await page.screenshot({ path: path.join(output, 'voice-input.png') });
  await application.evaluate(() => { globalThis.voicePastes = []; });
  await page.getByRole('button', { name: '插入终端', exact: true }).click();
  await waitFor(async () => application.evaluate(() => globalThis.voicePastes.some(item => /project folder/i.test(item.data))), 'dictation pasted into the same terminal');
  assert.equal(await application.evaluate(() => globalThis.voicePastes.some(item => item.data === '\r')), false, 'dictation does not press Enter');
  if (assets) assert.deepEqual(await fs.readdir(path.join(dataDir, 'voice/recordings')), []);
  console.log(`PASS: simulated microphone capture, ${assets ? 'real offline Whisper recognition' : 'UI-only recognition stub'}, editable transcript and paste without submitting`);
  console.log(`Screenshots: ${output}`);
} catch (error) {
  console.error(error); process.exitCode = 1;
  if (page) { console.error('UI error:', await page.locator('.form-error, .error-toast, .explorer-file-status').allTextContents().catch(() => [])); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
} finally { await restoreClipboard(); if (application) await application.close(); }
