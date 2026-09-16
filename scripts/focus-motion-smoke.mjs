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
let application, page;
const errors = [];
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
  application = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Project Grid.exe') : require('electron'), args: [...(packaged ? [] : [root]), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], cwd: root, env, timeout: 30000 });
  page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.webContents.setBackgroundThrottling(false); window.setBounds({ x: 40, y: 40, width: 1180, height: 780 });
  });
  await page.waitForSelector('.project-panel');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const id = projects.at(-1).id, panel = page.locator(`[data-project-id="${id}"]`);
  await panel.getByRole('button', { name: '启动终端', exact: true }).click();
  await page.waitForFunction(async id => (await window.projectGrid.getState()).value.projects.find(project => project.id === id).shellReady, id);
  const sessionId = (await page.evaluate(() => window.projectGrid.getState())).value.projects.find(project => project.id === id).sessionId;
  await panel.locator('textarea').focus(); await page.keyboard.type("Write-Output 'PENDING_INPUT'");
  await panel.evaluate(panel => { globalThis.motionTerminal = panel.querySelector('.terminal-host'); });
  const original = await panel.boundingBox();
  await page.screenshot({ path: path.join(output, 'overview.png') });
  await panel.locator('.panel-name').click();
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

  await panel.locator('.panel-name').click();
  await page.waitForSelector('.focus-motion-panel');
  await page.keyboard.press('Control+Shift+g');
  await settled(false); await landed(id);
  assert.equal(await page.locator('.project-panel:visible').count(), projects.length);
  await page.locator(`[data-project-id="${projects[0].id}"] .panel-name`).click();
  await settled(true); await landed(projects[0].id);
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await page.getByLabel('文件文本内容', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
  await settled(false); await landed(projects[0].id);
  assert.equal(await page.locator('.file-preview').count(), 0);
  console.log('PASS: quick reversal, another card, file preview return and window resize leave no floating or hidden cards');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await panel.locator('.panel-name').click(); await settled(true);
  assert.equal(await page.locator('.focus-motion-panel').count(), 0);
  await page.getByRole('button', { name: '返回总览', exact: true }).click(); await settled(false);
  await landed(id); assert.deepEqual(errors, []);
  console.log('PASS: reduced motion switches directly without a zoom animation');
  console.log(`Screenshots: ${output}`);
} catch (error) {
  console.error(error); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally { if (application) await application.close(); }
