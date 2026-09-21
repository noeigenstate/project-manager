import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.test-output', `composer-${Date.now()}`), profile = path.join(output, 'profile'), home = path.join(output, 'codex-home');
const projects = ['Codex 输入', '其他项目'].map((name, index) => ({ id: randomUUID(), name, path: path.join(output, `project-${index}`), restore: { terminal: false, codex: false } }));
for (const dir of [profile, home, ...projects.map(project => project.path)]) await fs.mkdir(dir, { recursive: true });
const requests = [], errors = [], samples = [];
const provider = http.createServer((request, response) => { requests.push({ method: request.method, url: request.url }); response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{"error":{"message":"Preview only; no model requests"}}'); });
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
await fs.writeFile(path.join(home, 'config.toml'), `model="gpt-6-astra"\nmodel_provider="preview"\ncheck_for_update_on_startup=false\n[model_providers.preview]\nname="Isolated preview"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[projects.'${projects[0].path}']\ntrust_level="trusted"\n`);
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { restoreSessions: false, closeToTray: false, notifications: false, fontSize: 14 } }));
const env = { ...process.env, PROJECT_GRID_DATA_DIR: profile, CODEX_HOME: home }; delete env.ELECTRON_RUN_AS_NODE; delete env.PROJECT_GRID_DEV_URL;
const packaged = process.argv.includes('--packaged'), doneFile = path.join(output, 'fixture.done');
let app, page, controlId;
const state = async () => (await page.evaluate(() => window.projectGrid.getState())).value;
const write = (id, data) => page.evaluate(({ id, data }) => window.projectGrid.writeTerminal(id, data), { id, data });
async function waitFor(check, label) { const until = Date.now() + 25000; while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 90)); } throw new Error(`Timed out: ${label}`); }
async function composerSample(terminal, label) {
  await waitFor(async () => terminal.locator('.xterm-rows span').evaluateAll(cells => cells.some(cell => /background-color:\s*(#1e1e1e|rgb\(30, 30, 30\))/.test(cell.getAttribute('style') || ''))), `${label}: Codex finished probing terminal colors`);
  const sample = await terminal.locator('.xterm-rows').evaluate(rows => {
    const context = document.createElement('canvas').getContext('2d');
    const rgba = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
    const cells = [...rows.querySelectorAll('span')].filter(cell => /background-color:\s*(#1e1e1e|rgb\(30, 30, 30\))/.test(cell.getAttribute('style') || '') && !cell.matches('.xterm-cursor-block,.xterm-decoration-top'));
    return { cells: cells.length, backgrounds: [...new Set(cells.map(cell => getComputedStyle(cell).backgroundColor))], dim: cells.filter(cell => cell.classList.contains('xterm-dim')).map(cell => rgba(getComputedStyle(cell).webkitTextFillColor)), text: rows.textContent };
  });
  assert.ok(sample.cells > 0, `${label}: actual Codex composer cells were captured`);
  assert.deepEqual(sample.backgrounds, ['rgba(0, 0, 0, 0)'], `${label}: input and padding are transparent`);
  for (const fill of sample.dim) assert.equal(fill[3], 255, 'faint hint glyphs are fully opaque');
  samples.push({ label, ...sample });
  return sample;
}
try {
  app = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Project Grid.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    // Keep every original format in memory only, never in logs or artifacts.
    globalThis.composerClipboardBackup = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
    globalThis.composerWriteText = clipboard.writeText.bind(clipboard);
    clipboard.writeText = async text => { await globalThis.composerWriteText(text); globalThis.composerClipboardOwner = text; };
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900));
  await page.waitForSelector('.project-panel');
  const first = page.locator(`[data-project-id="${projects[0].id}"]`);
  await first.getByRole('button', { name: '启动终端', exact: true }).click();
  await waitFor(async () => (await state()).projects[0].shellReady, 'shell ready');
  await first.getByRole('button', { name: `新增终端 ${projects[0].name}`, exact: true }).click();
  await waitFor(async () => (await state()).projects[0].terminals.length === 2 && (await state()).projects[0].terminals.every(terminal => terminal.shellReady), 'independent split ready');
  controlId = (await state()).projects[0].terminals[1].id;
  const terminal = page.locator(`[data-terminal-id="${projects[0].id}"]`), control = page.locator(`[data-terminal-id="${controlId}"]`);
  const fixture = '\x1b[48;2;30;30;30mDARK_SURFACE\x1b[0m\r\n\x1b[48;2;69;31;29mDIFF_RED\x1b[0m\r\n\x1b[48;2;29;60;35mDIFF_GREEN\x1b[0m\r\n\x1b[41mANSI_RED\x1b[0m\r\n\x1b[7mINVERSE\x1b[0m\r\n';
  const paint = `[Console]::Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(fixture).toString('base64')}')))`;
  await write(controlId, `Clear-Host; ${paint}\r`);
  const cellBackgrounds = () => control.locator('.xterm-rows').evaluate(rows => Object.fromEntries(['DARK_SURFACE', 'DIFF_RED', 'DIFF_GREEN', 'ANSI_RED', 'INVERSE'].map(label => {
    const cell = [...rows.querySelectorAll('span')].find(cell => cell.textContent.trim() === label);
    return [label, cell ? getComputedStyle(cell).backgroundColor : null];
  })));
  await waitFor(async () => (await cellBackgrounds()).INVERSE !== null, 'ANSI controls rendered');
  const original = await cellBackgrounds();
  assert.equal(original.DARK_SURFACE, 'rgb(30, 30, 30)');
  await write(projects[0].id, 'codex --no-alt-screen\r');
  await waitFor(async () => terminal.locator('.xterm-rows').innerText().then(text => text.includes('Ask Codex to do anything')), 'real offline Codex input prompt');
  await waitFor(async () => (await state()).projects[0].terminals[0].codexActive, 'Codex identity reaches renderer');
  assert.deepEqual(await cellBackgrounds(), original, 'another shell in the same project keeps all ANSI backgrounds');
  const sessions = (await state()).projects[0].terminals.map(terminal => terminal.sessionId);
  await terminal.locator('.terminal-host').evaluate(node => { globalThis.composerTerminal = node; });
  for (const theme of ['forest', 'mountain-blue', 'wild-red']) {
    await page.evaluate(theme => window.projectGrid.settings({ theme }), theme);
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    await composerSample(terminal, theme);
    await page.screenshot({ path: path.join(output, `${theme}-empty.png`) });
  }
  await terminal.locator('textarea.xterm-helper-textarea').focus();
  await page.evaluate(() => window.projectGrid.copy('第一行：透明输入与清晰文字'));
  await page.keyboard.press('Control+v');
  await waitFor(async () => terminal.locator('.xterm-rows').innerText().then(text => text.includes('第一行：透明输入与清晰文字')), 'first paste rendered before newline');
  await page.keyboard.press('Shift+Enter');
  await page.evaluate(() => window.projectGrid.copy('第二行：保留中文草稿'));
  await page.keyboard.press('Control+v');
  await waitFor(async () => terminal.locator('.xterm-rows').innerText().then(text => text.includes('保留中文草稿')), 'Chinese multiline draft');
  const draftRows = await terminal.locator('.xterm-rows > div').allTextContents();
  assert.equal(draftRows.findIndex(text => text.includes('第二行：保留中文草稿')), draftRows.findIndex(text => text.includes('第一行：透明输入与清晰文字')) + 1, 'Shift+Enter creates the next input line');
  assert.equal(await page.locator('.focus-mode').count(), 0, 'typing in the small card stays small');
  await composerSample(terminal, 'multiline');
  await page.screenshot({ path: path.join(output, 'multiline-small.png') });
  await page.keyboard.press('Control+Shift+a'); await page.keyboard.press('Control+c');
  assert.ok((await page.evaluate(() => window.projectGrid.readClipboard())).value.includes('第一行：透明输入与清晰文字'));
  await waitFor(async () => await terminal.locator('.xterm-decoration-top').count() > 0, 'selected cells rendered');
  assert.ok(await terminal.locator('.xterm-decoration-top:not(.xterm-cursor-block)').evaluateAll(cells => cells.every(cell => getComputedStyle(cell).backgroundColor === 'rgb(64, 87, 112)')), 'selection keeps its opaque blue background');
  await page.screenshot({ path: path.join(output, 'selection.png') }); await page.keyboard.press('Escape');
  await first.getByRole('button', { name: `全屏查看 ${projects[0].name}`, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await page.evaluate(() => window.projectGrid.settings({ fontSize: 17 }));
  await composerSample(terminal, 'focused-17px');
  await page.screenshot({ path: path.join(output, 'focused-draft.png') });
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await page.evaluate(() => window.projectGrid.settings({ fontSize: 14 }));
  await composerSample(terminal, 'returned');
  assert.deepEqual((await state()).projects[0].terminals.map(terminal => terminal.sessionId), sessions);
  assert.ok(await terminal.locator('.terminal-host').evaluate(node => node === globalThis.composerTerminal));
  await terminal.locator('textarea.xterm-helper-textarea').focus(); await page.keyboard.press('Control+c');
  await waitFor(async () => terminal.locator('.xterm-rows').innerText().then(text => text.includes('Ask Codex to do anything')), 'cleared draft restores placeholder');
  await composerSample(terminal, 'cleared');
  // An authenticated native fixture covers the same surface in output/history,
  // alongside backgrounds that must remain colored in an active Codex terminal.
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  await write(controlId, `Clear-Host; Send-ProjectGridEvent 'codex-started'; ${paint}; for ($pgComposer=0; $pgComposer -lt 1200 -and -not (Test-Path -LiteralPath ${quote(doneFile)}); $pgComposer++) { Start-Sleep -Milliseconds 100 }; Send-ProjectGridEvent 'codex-exited'\r`);
  await waitFor(async () => (await state()).projects[0].terminals[1].codexActive, 'control becomes an authenticated Codex fixture');
  await waitFor(async () => (await cellBackgrounds()).DARK_SURFACE === 'rgba(0, 0, 0, 0)', 'same dark history surface becomes transparent');
  const agentColors = await cellBackgrounds();
  for (const label of ['DIFF_RED', 'DIFF_GREEN', 'ANSI_RED', 'INVERSE']) assert.equal(agentColors[label], original[label], `${label} background survives`);
  assert.ok(!requests.some(request => request.method === 'POST'), `draft input must never submit a model request: ${JSON.stringify(requests)}`);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ packaged, samples, original, agentColors, sessions, requests, errors }, null, 2));
  console.log(`PASS: actual Codex transparent composer, bright hints, Chinese multiline paste, selection, focus/resize, independent split colors and no model submissions. Evidence: ${output}`);
} catch (error) {
  console.error(error);
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'failure-cells.json'), JSON.stringify(await page.locator('.xterm-rows span').evaluateAll(cells => cells.map(cell => ({ text: cell.textContent, className: cell.className, style: cell.getAttribute('style') }))), null, 2)).catch(() => {});
  }
  throw error;
}
finally {
  try {
    if (app) {
      try {
        await fs.writeFile(doneFile, 'done');
        if (page && !page.isClosed()) {
          for (let count = 0; count < 3; count++) { await write(projects[0].id, '\x03'); await new Promise(resolve => setTimeout(resolve, 250)); }
          await waitFor(async () => (await state()).projects[0].terminals.every(terminal => terminal.shellReady || terminal.status === 'exited'), 'test tasks return to their shells');
          for (const terminal of (await state()).projects[0].terminals) await write(terminal.id, '\x03exit\r');
          await waitFor(async () => (await state()).projects[0].terminals.every(terminal => terminal.status === 'exited'), 'test shells exit');
        }
      } finally {
        try {
          await app.evaluate(async ({ clipboard }) => {
            if (globalThis.composerWriteText) clipboard.writeText = globalThis.composerWriteText;
            if (globalThis.composerClipboardOwner !== undefined && await clipboard.readText() === globalThis.composerClipboardOwner) {
              if (globalThis.composerClipboardBackup?.length) await clipboard.write(globalThis.composerClipboardBackup); else await clipboard.clear();
            }
          });
        } finally { await app.close(); }
      }
    }
  } finally {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
}
