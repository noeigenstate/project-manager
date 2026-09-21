import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const output = path.join(root, '.test-output', `visual-${Date.now()}`);
const profile = path.join(output, 'profile'), home = path.join(output, 'codex-home');
const names = ['界面开发', '文档整理', '本地工具', '服务接口', '数据处理', '工具项目'];
const projects = names.map((name, index) => ({ id: randomUUID(), name, path: path.join(output, name), unread: index === 1 ? 1 : 0, lastCompletedAt: index === 1 ? Date.now() - 60000 : null, restore: { terminal: false, codex: false } }));
const doneFile = path.join(projects[0].path, 'task.done');
for (const directory of [profile, path.join(home, 'sessions'), ...projects.map(project => project.path)]) await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(projects[0].path, 'README.md'), '# 清晰的工作区\n\n保留文字、代码和状态的层次。\n');
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { columns: 3, notifications: false, sound: false, closeToTray: false, restoreSessions: false, fontSize: 14 } }));
const env = { ...process.env, PROJECT_GRID_DATA_DIR: profile, CODEX_HOME: home }; delete env.ELECTRON_RUN_AS_NODE; delete env.PROJECT_GRID_DEV_URL;
const packaged = process.argv.includes('--packaged');
let app, page;
async function waitFor(check, name) { const until = Date.now() + 20000; while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 70)); } throw new Error(`Timed out: ${name}`); }
const state = async () => (await page.evaluate(() => window.projectGrid.getState())).value;
const panel = index => page.locator(`[data-project-id="${projects[index].id}"]`);
const write = (index, data) => page.evaluate(({ id, data }) => window.projectGrid.writeTerminal(id, data), { id: projects[index].id, data });
const breathing = index => panel(index).evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.animationName === 'signal-breathe').length);
const errors = [];
try {
  app = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Project Grid.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900));
  await page.waitForSelector('.project-panel');
  for (let index = 0; index < 4; index++) {
    await panel(index).getByRole('button', { name: '启动终端', exact: true }).click();
    await waitFor(async () => (await state()).projects[index].shellReady, 'native terminal ready');
    await write(index, `Clear-Host; Write-Host 'Project Grid / ${names[index]}'; Write-Host ''; Write-Host '  项目、终端和输入草稿各自独立。'; Write-Host '  Ctrl + 鼠标左键打开文件与链接'; Write-Host ''; Write-Host '  PASS  ANSI colors and readable text' -ForegroundColor Green; Write-Host '  INFO  状态变更后继续工作' -ForegroundColor Cyan\r`);
    await waitFor(async () => panel(index).locator('.xterm-rows').innerText().then(text => text.includes('ANSI colors and readable text')), 'readable terminal output');
  }
  const thread = randomUUID(), transcript = path.join(home, 'sessions', `rollout-${thread}.jsonl`);
  const record = (type, turn) => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: turn } }) + '\n';
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  await write(0, `Clear-Host; Write-Host 'Project Grid / 界面开发'; Write-Host ''; Write-Host '  正在处理：验证独立项目的任务状态' -ForegroundColor Cyan; Write-Host '  背景任务运行中，可操作其他窗口。'; Write-Host ''; Send-ProjectGridEvent 'codex-started'; for ($pgVisual=0; $pgVisual -lt 2400 -and -not (Test-Path -LiteralPath ${quote(doneFile)}); $pgVisual++) { Start-Sleep -Milliseconds 100 }; Send-ProjectGridEvent 'codex-exited'\r`);
  await waitFor(async () => (await state()).projects[0].codexActive, 'offline task active');
  await fs.writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd: projects[0].path, source: 'cli' } }) + '\n' + record('task_started', 'visual-turn'));
  await waitFor(async () => panel(0).getAttribute('data-status').then(status => status === 'working'), 'working lifecycle reaches UI');
  await page.getByRole('textbox', { name: '搜索项目', exact: true }).focus(); await page.mouse.move(2, 2);
  assert.equal(await page.locator('.panel-edge-light').count(), 0, 'old decorative strips are removed');
  assert.equal(await panel(0).evaluate(node => getComputedStyle(node).animationName), 'none', 'the text surface is not animated');
  const liveSamples = [];
  for (const mode of ['normal', 'hover', 'input-focus']) {
    if (mode === 'hover') await panel(0).locator('.panel-header').hover();
    if (mode === 'input-focus') { await panel(0).locator('textarea.xterm-helper-textarea').focus(); await page.mouse.move(2, 2); }
    const samples = await panel(0).evaluate(async node => {
      const edge = node.querySelector('.panel-signal'), dot = node.querySelector('.status-dot'), text = node.querySelector('.xterm-rows');
      const values = [];
      for (let index = 0; index < 24; index++) {
        const lights = [edge, dot].map(light => { const style = getComputedStyle(light); return { opacity: Number(style.opacity), low: Number(style.getPropertyValue('--light-low')), peak: Number(style.getPropertyValue('--light-peak')) }; });
        values.push({ lights, text: { opacity: getComputedStyle(text).opacity, color: getComputedStyle(text).color, animation: getComputedStyle(text).animationName } });
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return values;
    });
    const ranges = [0, 1].map(index => { const values = samples.map(sample => sample.lights[index].opacity); return [Math.min(...values), Math.max(...values)]; });
    assert.ok(ranges.every(([low, high]) => low < .25 && high > .93 && high - low > .65), `${mode}: clearly dark and bright phases ${JSON.stringify(ranges)}`);
    for (const sample of samples) {
      const phase = sample.lights.map(light => (light.opacity - light.low) / (light.peak - light.low));
      assert.ok(Math.abs(phase[0] - phase[1]) < .06, `${mode}: edge and dot brighten together`);
      assert.deepEqual(sample.text, samples[0].text, `${mode}: reading surface stays steady`);
      assert.equal(sample.text.opacity, '1'); assert.equal(sample.text.animation, 'none');
    }
    liveSamples.push({ mode, ranges, samples });
  }
  await page.getByRole('textbox', { name: '搜索项目', exact: true }).focus(); await page.mouse.move(2, 2);
  const timings = await panel(0).evaluate(node => ['.panel-signal', '.status-dot'].map(selector => {
    const animation = node.querySelector(selector).getAnimations()[0];
    return { start: animation.startTime, duration: animation.effect.getTiming().duration, infinite: animation.effect.getTiming().iterations === Infinity };
  }));
  assert.ok(Math.abs(timings[0].start - timings[1].start) < 35, 'dot and border share the same phase');
  assert.ok(timings.every(timing => timing.duration === 2000 && timing.infinite));
  assert.equal(await breathing(1), 0, 'old unread completion stays quiet');
  assert.equal(await breathing(2), 0, 'ready shell stays quiet');
  for (const [name, time] of [['low', 0], ['peak', 1000], ['low-again', 2000]]) {
    await panel(0).evaluate((node, time) => { for (const animation of node.getAnimations({ subtree: true })) { if (animation.animationName === 'signal-breathe') { animation.pause(); animation.currentTime = time; } } }, time);
    await page.screenshot({ path: path.join(output, `forest-${name}.png`) });
    const opacity = await panel(0).locator('.panel-signal').evaluate(node => Number(getComputedStyle(node).opacity));
    assert.ok(name === 'peak' ? opacity >= .94 : opacity <= .2, `${name}: ${opacity}`);
  }
  await panel(0).evaluate(node => { for (const animation of node.getAnimations({ subtree: true })) if (animation.animationName === 'signal-breathe') animation.currentTime = 1000; });
  const surface = await panel(0).evaluate(node => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height, viewport: innerWidth, backdrop: getComputedStyle(node).backdropFilter };
  });
  const refracted = await page.screenshot({ path: path.join(output, 'liquid-refraction.png') });
  await page.locator('#project-grid-refraction feDisplacementMap').evaluate(node => node.setAttribute('scale', '0'));
  const flat = await page.screenshot({ path: path.join(output, 'liquid-without-refraction.png') });
  await page.locator('#project-grid-refraction feDisplacementMap').evaluate(node => node.setAttribute('scale', '14'));
  const lens = await app.evaluate(({ nativeImage }, { before, after, surface }) => {
    const a = nativeImage.createFromBuffer(Buffer.from(before, 'base64')), b = nativeImage.createFromBuffer(Buffer.from(after, 'base64'));
    const { width } = a.getSize(), scale = width / surface.viewport, first = a.toBitmap(), second = b.toBitmap();
    let changed = 0, peak = 0;
    for (let y = Math.ceil((surface.y + surface.height * .4) * scale); y < (surface.y + surface.height * .8) * scale; y++) {
      for (let x = Math.ceil((surface.x + 3) * scale); x < (surface.x + surface.width * .035) * scale; x++) {
        const at = (y * width + x) * 4, delta = Math.max(...[0, 1, 2].map(channel => Math.abs(first[at + channel] - second[at + channel])));
        if (delta > 2) changed++; peak = Math.max(peak, delta);
      }
    }
    return { changed, peak, backdrop: surface.backdrop };
  }, { before: refracted.toString('base64'), after: flat.toString('base64'), surface });
  assert.ok(lens.changed > 10 && lens.peak > 3, `SVG must actually refract the backdrop: ${JSON.stringify(lens)}`);
  for (const [theme, name] of [['mountain-blue', '山青蓝'], ['wild-red', '西野红']]) {
    await page.evaluate(theme => window.projectGrid.settings({ theme }), theme);
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    await page.screenshot({ path: path.join(output, `${theme}.png`) });
    assert.equal(await panel(0).locator('.status-badge').innerText(), '正在处理');
    assert.equal(await breathing(2), 0, `${name}: ready shell stays quiet`);
  }
  await page.evaluate(() => window.projectGrid.settings({ theme: 'forest' }));
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'forest');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false });
  await page.screenshot({ path: path.join(output, 'forest-3840x2160.png') });
  await cdp.send('Emulation.clearDeviceMetricsOverride'); await cdp.detach();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(820, 560));
  await page.waitForFunction(() => Math.abs(innerWidth - 820) <= 1); // Windows DPI can round the client width by one CSS pixel.
  const compact = await page.locator('.panel-header').evaluateAll(headers => headers.map(header => {
    const bounds = header.getBoundingClientRect(), name = header.querySelector('.panel-name').getBoundingClientRect();
    return { titleWidth: name.width, inside: [...header.children].filter(child => getComputedStyle(child).display !== 'none').every(child => { const box = child.getBoundingClientRect(); return box.left >= bounds.left && box.right <= bounds.right + 1; }), metaSize: getComputedStyle(header.parentElement.querySelector('.panel-meta')).fontSize };
  }));
  await page.screenshot({ path: path.join(output, 'compact-820x560.png') });
  assert.ok(compact.every(card => card.inside && card.titleWidth >= 70 && parseFloat(card.metaSize) >= 11), JSON.stringify(compact));
  const compactEdges = await page.evaluate(() => {
    const top = document.querySelector('.titlebar').getBoundingClientRect(), bottom = document.querySelector('.workspace-statusbar').getBoundingClientRect();
    return { top: top.top, left: top.left, right: top.right, bottom: bottom.bottom, bottomLeft: bottom.left, bottomRight: bottom.right, width: innerWidth, height: innerHeight };
  });
  assert.ok([compactEdges.top, compactEdges.left, compactEdges.bottomLeft, compactEdges.right - compactEdges.width, compactEdges.bottomRight - compactEdges.width, compactEdges.bottom - compactEdges.height].every(gap => Math.abs(gap) < 1), `compact bars meet viewport edges within DPI rounding: ${JSON.stringify(compactEdges)}`);
  await panel(3).locator('.panel-terminal-area').click({ position: { x: 40, y: 50 } });
  await page.keyboard.type('DRAFT_STAYS_SMALL'); assert.equal(await page.locator('.focus-mode').count(), 0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900));
  await panel(0).getByRole('button', { name: `全屏查看 ${names[0]}`, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await page.screenshot({ path: path.join(output, 'focused-explorer.png') });
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await fs.appendFile(transcript, record('task_complete', 'visual-turn'));
  await waitFor(async () => panel(0).evaluate(node => node.classList.contains('attention-active')), 'new completion breathes');
  assert.equal(await breathing(0), 2, 'one edge and one status dot animate');
  const completed = (await state()).projects[0].lastCompletedAt;
  await page.screenshot({ path: path.join(output, 'fresh-completion.png') });
  await waitFor(async () => (await breathing(0)) === 0, 'three completion cycles finish');
  // Rerender via theme changes and repeated lifecycle callbacks must not restart an old alert.
  await fs.appendFile(transcript, record('task_complete', 'visual-turn'));
  await page.evaluate(() => window.projectGrid.settings({ theme: 'wild-red' }));
  assert.equal(await breathing(0), 0); assert.equal((await state()).projects[0].lastCompletedAt, completed);
  await page.evaluate(id => window.projectGrid.acknowledge(id), projects[0].id);
  await waitFor(async () => panel(0).evaluate(node => node.classList.contains('round-complete')), 'viewed automatic round becomes steady green');
  assert.equal(await breathing(0), 0);
  assert.equal(await panel(0).locator('.status-badge').innerText(), '本轮已完成');
  assert.equal(await panel(0).evaluate(node => getComputedStyle(node).getPropertyValue('--signal-rgb').trim()), '75, 237, 164');
  await page.screenshot({ path: path.join(output, 'automatic-completion.png') });
  await panel(0).locator('.panel-terminal-area').click({ position: { x: 40, y: 50 } });
  assert.equal(await page.locator('.focus-mode').count(), 0, 'automatic green does not expand on terminal clicks');
  await fs.appendFile(transcript, record('task_started', 'next-turn'));
  await waitFor(async () => panel(0).getAttribute('data-status').then(status => status === 'working'), 'new submitted turn resumes breathing');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await breathing(0), 0, 'system reduced motion disables decorative breathing');
  await page.screenshot({ path: path.join(output, 'reduced-motion.png') });
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ packaged, timings, lens, liveSamples, compact, compactEdges, errors }, null, 2));
  console.log(`PASS: live 2-second synchronized lights, finite completion, quiet idle, all themes, high DPI, compact controls, explorer and preserved small-card input. Screenshots: ${output}`);
} catch (error) {
  console.error(error);
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    console.error('Visual test viewport:', await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })).catch(() => null));
  }
  throw error;
} finally {
  // Release our simulated task and exit only this isolated profile's shells
  // before Electron tears down ConPTY handles.
  await fs.writeFile(doneFile, 'done');
  if (app) {
    try {
      if (page && !page.isClosed()) {
        const active = (await state()).projects.filter(project => project.sessionId && project.status !== 'exited');
        if (active.some(project => project.id === projects[0].id)) await waitFor(async () => {
          const project = (await state()).projects.find(project => project.id === projects[0].id);
          return project.shellReady || project.status === 'exited';
        }, 'visual task returned to its shell');
        for (const project of active) await page.evaluate(id => window.projectGrid.writeTerminal(id, '\x03exit\r'), project.id);
        await waitFor(async () => (await state()).projects.every(project => !project.sessionId || project.status === 'exited'), 'visual fixture shells exited');
        console.log('PASS: isolated visual task and terminal processes exited before closing the app');
      }
    } finally { await app.close(); }
  }
}
