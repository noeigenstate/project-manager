import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url), exec = promisify(execFile), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.test-output', `path-refresh-${Date.now()}`), profile = path.join(output, 'profile'), bin = path.join(output, 'inherited-bin'), home = path.join(output, 'codex-home');
const project = { id: randomUUID(), name: '环境刷新', path: path.join(output, 'project'), restore: { terminal: false, codex: false } };
for (const folder of [profile, bin, home, project.path]) await fs.mkdir(folder, { recursive: true });
await fs.writeFile(path.join(bin, 'project-grid-extra.cmd'), '@echo off\r\necho EXTRA_PATH_OK\r\n');
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { restoreSessions: false, closeToTray: false, notifications: false } }));
const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), powershell = path.join(system32, 'WindowsPowerShell/v1.0/powershell.exe');
const env = { ...process.env, PROJECT_GRID_DATA_DIR: profile, CODEX_HOME: home, PG_PATH_SENTINEL: 'keep-me' };
const inherited = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
const normalize = value => value.trim().replace(/^"|"$/g, '').replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
const omitted = [system32, path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64')].map(normalize);
env.Path = bin + ';' + inherited.split(';').filter(value => !omitted.includes(normalize(value))).join(';');
delete env.ELECTRON_RUN_AS_NODE; delete env.PROJECT_GRID_DEV_URL;
// Model an app started before the installer added a directory. Reading actual
// stored Windows PATH needs no registry edits and works on CI without MiMo.
const before = await exec(powershell, ['-NoLogo', '-NoProfile', '-Command', '[bool](Get-Command where.exe -CommandType Application -ErrorAction SilentlyContinue)'], { env, windowsHide: true, timeout: 10000 });
assert.equal(before.stdout.trim(), 'False', 'stale parent environment cannot find the probe');
const packaged = process.argv.includes('--packaged'), errors = [], proofs = [];
const executableIndex = process.argv.indexOf('--executable');
const executable = executableIndex >= 0 ? path.resolve(process.argv[executableIndex + 1]) : null;
let app, page;
const state = async () => (await page.evaluate(() => window.projectGrid.getState())).value.projects[0];
const write = (id, data) => page.evaluate(({ id, data }) => window.projectGrid.writeTerminal(id, data), { id, data });
async function waitFor(check, label) { const until = Date.now() + 25000; while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 80)); } throw new Error(`Timed out: ${label}`); }
async function prove(id, label) {
  const name = `${label}.json`;
  await write(id, `[IO.File]::WriteAllText((Join-Path (Get-Location).Path '${name}'), (@{pid=$PID;command=(Get-Command where.exe -CommandType Application | Select-Object -First 1).Source;run=(@(& where.exe where.exe));extra=(Get-Command project-grid-extra.cmd).Source;kept=$env:PG_PATH_SENTINEL;mimo=(Get-Command mimo.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source} | ConvertTo-Json -Compress))\r`);
  const file = path.join(project.path, name);
  await waitFor(async () => fs.readFile(file, 'utf8').then(text => { try { return !!JSON.parse(text).command; } catch { return false; } }, () => false), label);
  await waitFor(async () => (await state()).terminals.find(terminal => terminal.id === id).shellReady, 'probe returns to prompt');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(normalize(value.command), normalize(path.join(system32, 'where.exe')));
  assert.ok(value.run.some(location => normalize(location) === normalize(value.command)), 'the newly resolved native command executes');
  assert.equal(normalize(value.extra), normalize(path.join(bin, 'project-grid-extra.cmd')));
  assert.equal(value.kept, 'keep-me');
  proofs.push({ label, ...value }); return value;
}
try {
  app = await electron.launch({ executablePath: executable || (packaged ? path.join(root, 'release/win-unpacked/Project Grid.exe') : require('electron')), args: executable || packaged ? [] : [root], cwd: root, env });
  const appPid = app.process().pid;
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await page.waitForSelector('.project-panel');
  const panel = page.locator(`[data-project-id="${project.id}"]`);
  await panel.getByRole('button', { name: '启动终端', exact: true }).click();
  await waitFor(async () => (await state()).shellReady, 'initial terminal');
  const first = await prove(project.id, 'initial');
  await panel.getByRole('button', { name: `新增终端 ${project.name}`, exact: true }).click();
  await waitFor(async () => (await state()).terminals.length === 2 && (await state()).terminals.every(terminal => terminal.shellReady), 'new split');
  const neighbor = (await state()).terminals[1]; await prove(neighbor.id, 'split');
  await write(neighbor.id, "Write-Output 'NEIGHBOR_DRAFT_STAYS'");
  const primary = page.locator(`[data-terminal-id="${project.id}"]`);
  await primary.locator('.terminal-split-body').click({ position: { x: 30, y: 60 } });
  const firstSession = (await state()).terminals[0].sessionId;
  await panel.getByRole('button', { name: `${project.name} 的更多操作`, exact: true }).click();
  await page.getByRole('menuitem', { name: '重启当前终端', exact: true }).click();
  await waitFor(async () => { const terminal = (await state()).terminals[0]; return terminal.sessionId !== firstSession && terminal.shellReady; }, 'menu restarts only the selected terminal');
  const restarted = await prove(project.id, 'restarted'); assert.notEqual(restarted.pid, first.pid);
  const splitSession = (await state()).terminals[0].sessionId;
  await primary.getByRole('button', { name: `重启 ${project.name} 终端 1`, exact: true }).click();
  await waitFor(async () => { const terminal = (await state()).terminals[0]; return terminal.sessionId !== splitSession && terminal.shellReady; }, 'split header restarts the terminal');
  await prove(project.id, 'split-header-restarted');
  await write(project.id, 'exit\r');
  await waitFor(async () => (await state()).terminals[0].status === 'exited', 'shell exits');
  await primary.getByRole('button', { name: '重新启动', exact: true }).click();
  await waitFor(async () => (await state()).terminals[0].shellReady, 'reopened terminal');
  await prove(project.id, 'reopened');
  assert.equal((await state()).terminals[1].sessionId, neighbor.sessionId, 'neighbor session survives');
  assert.ok((await page.evaluate(id => window.projectGrid.attachTerminal(id), neighbor.id)).value.data.includes('NEIGHBOR_DRAFT_STAYS'));
  assert.equal(app.process().pid, appPid, 'Project Grid has not restarted');
  const parentUnchanged = await app.evaluate((_electron, original) => process.env.Path === original, env.Path);
  assert.ok(parentUnchanged, 'parent PATH stays unchanged');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'refreshed-terminals.png') });
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ packaged, executable, appPid, parentUnchanged, proofs, errors }, null, 2));
  console.log(`PASS: unchanged app process opens/restarts local terminals with fresh Windows PATH, preserves injected tools and neighbor drafts. Evidence: ${output}`);
} catch (error) { console.error(error); if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally {
  if (app) {
    try {
      if (page && !page.isClosed()) {
        for (const terminal of (await state()).terminals) if (terminal.sessionId && terminal.status !== 'exited') await write(terminal.id, '\x03exit\r');
        await waitFor(async () => (await state()).terminals.every(terminal => !terminal.sessionId || terminal.status === 'exited'), 'isolated shells exit');
      }
    } finally { await app.close(); }
  }
}
