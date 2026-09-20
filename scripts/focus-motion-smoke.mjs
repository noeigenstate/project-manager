import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.test-output', `focus-motion-${Date.now()}`);
const dataDir = path.join(output, 'profile');
await fs.mkdir(dataDir, { recursive: true });
const projects = [];
for (const name of ['界面开发', '服务接口', '数据处理', '工具项目', '文档整理', '动画验证']) {
  const project = { id: randomUUID(), name, path: path.join(output, name), restore: { terminal: false, codex: false } };
  await fs.mkdir(project.path); await fs.writeFile(path.join(project.path, 'README.md'), '# Animation fixture');
  projects.push(project);
}
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { notifications: false, closeToTray: false, restoreSessions: false } }));
const env = { ...process.env, PROJECT_GRID_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE; delete env.PROJECT_GRID_DEV_URL;
const packaged = process.argv.includes('--packaged');
const executableIndex = process.argv.indexOf('--executable');
const actualExecutable = executableIndex >= 0 ? path.resolve(process.argv[executableIndex + 1]) : null;
let application, page;
const errors = [];
async function waitFor(check, label) { const until = Date.now() + 20000; while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 60)); } throw new Error(`Timed out: ${label}`); }
async function settled(focused) {
  await page.waitForFunction(expected => !document.querySelector('.focus-motion-panel') && !!document.querySelector('.focus-mode') === expected, focused);
  await page.waitForFunction(() => !document.querySelector('[data-focus-motion]'));
}
async function landed(id) {
  const gap = await page.locator(`[data-project-id="${id}"]`).evaluate(panel => {
    const actual = panel.getBoundingClientRect(), slot = panel.parentElement.getBoundingClientRect();
    return Math.abs(actual.left - slot.left) + Math.abs(actual.top - slot.top) + Math.abs(actual.width - slot.width) + Math.abs(actual.height - slot.height);
  });
  assert.ok(gap < 2, `panel must land in its layout slot, gap=${gap}`);
}
try {
  application = await electron.launch({ executablePath: actualExecutable || (packaged ? path.join(root, 'release/win-unpacked/Project Grid.exe') : require('electron')), args: actualExecutable || packaged ? [] : [root], cwd: root, env, timeout: 30000 });
  page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  // Playwright defaults to no-preference even without an explicit override.
  // null restores the real Windows setting used by the installed application.
  await page.emulateMedia({ reducedMotion: null });
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ x: 40, y: 40, width: 1180, height: 780 }); window.focus();
  });
  await page.waitForSelector('.project-panel');
  console.log('System reduced motion:', await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling()), false, 'the installed app itself keeps visible animations rendering');
  const id = projects.at(-1).id, panel = page.locator(`[data-project-id="${id}"]`);
  await panel.getByRole('button', { name: '启动终端', exact: true }).click();
  await waitFor(async () => (await page.evaluate(() => window.projectGrid.getState())).value.projects.find(project => project.id === id).shellReady, 'initial PowerShell prompt');
  await panel.locator('.panel-terminal-area').click({ position: { x: 36, y: 95 } });
  await page.keyboard.type("[IO.File]::WriteAllText('first-line.txt', 'FIRST')");
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type("[IO.File]::WriteAllText('second-line.txt', 'SECOND')");
  assert.equal(await fs.access(path.join(projects.at(-1).path, 'first-line.txt')).then(() => true, () => false), false, 'Shift+Enter inserts a line without executing a complete PowerShell command');
  assert.equal(await page.locator('.focus-mode').count(), 0);
  await page.keyboard.press('Enter');
  await waitFor(async () => fs.access(path.join(projects.at(-1).path, 'second-line.txt')).then(() => true, () => false), 'both submitted PowerShell lines execute');
  await waitFor(async () => (await page.evaluate(() => window.projectGrid.getState())).value.projects.find(project => project.id === id).shellReady, 'PowerShell prompt after multiline input');
  assert.equal(await fs.readFile(path.join(projects.at(-1).path, 'first-line.txt'), 'utf8'), 'FIRST');
  assert.equal(await fs.readFile(path.join(projects.at(-1).path, 'second-line.txt'), 'utf8'), 'SECOND');
  console.log('PASS: real PowerShell edits two lines with Shift+Enter and executes both only after Enter');
  const sessionId = (await page.evaluate(() => window.projectGrid.getState())).value.projects.find(project => project.id === id).sessionId;
  await panel.locator('.panel-terminal-area').click({ position: { x: 36, y: 95 } });
  await page.keyboard.type("Write-Output 'PENDING_INPUT'");
  assert.equal(await page.locator('.focus-mode').count(), 0, 'clicking the terminal input and typing stays in the small card');
  assert.equal(await panel.locator('textarea').evaluate(element => element === document.activeElement), true);
  await panel.locator('.panel-meta').click();
  assert.equal(await page.locator('.focus-mode').count(), 0, 'the footer does not expand the card');
  await panel.evaluate(panel => { globalThis.motionTerminal = panel.querySelector('.terminal-host'); });
  const outputRow = panel.locator('.xterm-rows > div').filter({ hasText: 'PROJECT GRID' }).first();
  const rowBox = await outputRow.boundingBox();
  await page.mouse.move(rowBox.x + 12, rowBox.y + rowBox.height / 2); await page.mouse.down();
  await page.mouse.move(rowBox.x + 108, rowBox.y + rowBox.height / 2, { steps: 6 }); await page.mouse.up();
  assert.equal(await page.locator('.focus-mode').count(), 0, 'dragging text in an ordinary card keeps it in the overview');
  assert.equal(await panel.locator('.terminal-host').getAttribute('data-has-selection'), 'true');
  const original = await panel.boundingBox();
  const overviewViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.screenshot({ path: path.join(output, 'overview.png') });
  await panel.locator('.panel-header').click({ position: { x: 8, y: 8 } });
  await page.waitForSelector('[data-focus-motion="opening"] .focus-motion-panel');
  const mid = await panel.evaluate(panel => {
    const animation = panel.getAnimations().find(animation => animation.effect.getKeyframes().some(frame => frame.transform));
    animation.pause(); animation.currentTime = Number(animation.effect.getTiming().duration) * .35;
    const box = panel.getBoundingClientRect();
    return { width: box.width, height: box.height, targetWidth: panel.offsetWidth, targetHeight: panel.offsetHeight };
  });
  assert.ok(mid.width > original.width + 5 && mid.width < mid.targetWidth - 5, 'opening has intermediate widths between the card and fullscreen');
  assert.ok(mid.height > original.height + 5 && mid.height < mid.targetHeight - 5, 'opening has intermediate heights');
  await page.screenshot({ path: path.join(output, 'expanding.png') });
  await panel.evaluate(panel => panel.getAnimations().forEach(animation => animation.play()));
  await settled(true); await landed(id);
  await page.screenshot({ path: path.join(output, 'focused.png') });
  assert.ok(await panel.evaluate(panel => panel.querySelector('.terminal-host') === globalThis.motionTerminal));
  const full = await panel.boundingBox();
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await page.waitForSelector('[data-focus-motion="closing"] .focus-motion-panel');
  await page.waitForFunction(({ id, viewport }) => {
    const panel = document.querySelector(`[data-project-id="${id}"]`);
    return innerWidth === viewport.width && innerHeight === viewport.height && panel.classList.contains('focus-motion-panel') && Math.abs(panel.offsetWidth - panel.parentElement.offsetWidth) < 2;
  }, { id, viewport: overviewViewport });
  const shrinking = await panel.evaluate(panel => {
    const animation = panel.getAnimations().find(animation => animation.effect.getKeyframes().some(frame => frame.transform));
    animation.pause(); animation.currentTime = Number(animation.effect.getTiming().duration) * .35;
    const box = panel.getBoundingClientRect();
    return { width: box.width, targetWidth: panel.offsetWidth, right: box.right, bottom: box.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  assert.ok(shrinking.width > shrinking.targetWidth + 5 && shrinking.width < full.width - 5, 'return shrinks continuously into the grid');
  assert.ok(shrinking.right <= shrinking.viewportWidth + 1 && shrinking.bottom <= shrinking.viewportHeight + 1, 'the whole shrinking card remains inside the smaller native window');
  await page.screenshot({ path: path.join(output, 'returning.png') });
  await panel.evaluate(panel => panel.getAnimations().forEach(animation => animation.play()));
  await settled(false); await landed(id);
  assert.ok(await panel.evaluate(panel => panel.querySelector('.terminal-host') === globalThis.motionTerminal));
  assert.equal((await page.evaluate(() => window.projectGrid.getState())).value.projects.find(project => project.id === id).sessionId, sessionId);
  assert.ok((await panel.innerText()).includes('PENDING_INPUT'), 'unsubmitted terminal input survives both transitions');
  console.log('PASS: last card expands and shrinks through intermediate bounds, with the same live terminal and pending input');

  // Observe natural playback as well as the paused screenshots above. The old
  // fast easing completed almost all visible growth in its first 150 ms.
  await panel.evaluate(panel => {
    globalThis.focusMotionSamples = [];
    const started = performance.now();
    const sample = () => {
      globalThis.focusMotionSamples.push({ time: performance.now() - started, width: panel.getBoundingClientRect().width, moving: panel.classList.contains('focus-motion-panel') });
      if (performance.now() - started < 1600) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const naturalStart = (await panel.boundingBox()).width;
  await panel.getByRole('button', { name: `全屏查看 ${projects.at(-1).name}`, exact: true }).click();
  await settled(true);
  const naturalEnd = (await panel.boundingBox()).width;
  const samples = await page.evaluate(() => globalThis.focusMotionSamples);
  const growing = samples.filter(sample => sample.moving && sample.width > naturalStart + (naturalEnd - naturalStart) * .05 && sample.width < naturalStart + (naturalEnd - naturalStart) * .92);
  assert.ok(growing.length >= 4, 'natural playback must render several visibly different intermediate sizes');
  assert.ok(growing.at(-1).time - growing[0].time >= 200, 'visible enlargement must be gradual, not concentrated into the first few frames');
  await fs.writeFile(path.join(output, 'natural-motion.json'), JSON.stringify(samples));
  await page.keyboard.press('Control+Shift+g'); await settled(false);
  console.log('PASS: only the header/expand button opens the card; unpaused animation works without test-only rendering flags');

  await page.evaluate(id => window.projectGrid.markDone(id, true), id);
  await page.waitForFunction(id => document.querySelector(`[data-project-id="${id}"]`).classList.contains('is-done'), id);
  await panel.locator('.panel-terminal-area').click({ position: { x: 36, y: 95 } });
  assert.equal(await page.locator('.focus-mode').count(), 0, 'green-card terminal input stays in the overview too');
  await panel.locator('.panel-header').click({ position: { x: 8, y: 8 } });
  await settled(true); await landed(id);
  await page.keyboard.press('Control+Shift+g'); await settled(false);
  await page.evaluate(id => window.projectGrid.markDone(id, false), id);
  console.log('PASS: completed cards also require an explicit header click to expand');

  await panel.locator('.panel-name').click();
  await page.waitForSelector('.focus-motion-panel');
  await page.keyboard.press('Control+Shift+g');
  await settled(false); await landed(id);
  assert.equal(await page.locator('.project-panel:visible').count(), projects.length);
  await page.locator(`[data-project-id="${projects[0].id}"] .panel-name`).click();
  await settled(true); await landed(projects[0].id);
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await page.getByLabel('文件编辑器', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
  await settled(false); await landed(projects[0].id);
  assert.equal(await page.locator('.file-preview').count(), 0);
  console.log('PASS: quick reversal, another card, file preview return and window resize leave no floating or hidden cards');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await panel.locator('.panel-name').click();
  await page.waitForSelector('.focus-motion-panel');
  await settled(true); await landed(id);
  await page.getByRole('button', { name: '返回总览', exact: true }).click(); await settled(false);
  console.log('PASS: default smooth zoom remains enabled when Windows reduces system animations');

  await page.getByRole('button', { name: '工作台设置', exact: true }).click();
  await page.getByLabel('窗口放大动画', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'motion-settings.png') });
  await page.getByLabel('窗口放大动画', { exact: true }).selectOption('system');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await panel.locator('.panel-name').click(); await settled(true);
  assert.equal(await page.locator('.focus-motion-panel').count(), 0);
  await page.getByRole('button', { name: '返回总览', exact: true }).click(); await settled(false);
  await landed(id); assert.deepEqual(errors, []);
  console.log('PASS: choosing follow-system respects reduced motion');

  await page.getByRole('button', { name: '工作台设置', exact: true }).click();
  await page.getByLabel('窗口放大动画', { exact: true }).selectOption('off');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await panel.locator('.panel-name').click(); await settled(true);
  assert.equal(await page.locator('.focus-motion-panel').count(), 0);
  await page.getByRole('button', { name: '返回总览', exact: true }).click(); await settled(false);
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'workspace.json'), 'utf8'));
  assert.equal(persisted.settings.focusAnimation, 'off');
  console.log('PASS: animation can be disabled and the preference persists');
  console.log(`Screenshots: ${output}`);
} catch (error) {
  console.error(error); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally { if (application) await application.close(); }
