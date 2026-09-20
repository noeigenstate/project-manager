import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const { createSSHFixture } = require('../tests/helpers/ssh-fixture.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.test-output', `themes-markdown-${Date.now()}`), profile = path.join(output, 'profile');
const ssh = await createSSHFixture({ nativeWorker: false });
const projects = ['产品工作台', '等待查看', '工具项目'].map((name, index) => ({ id: randomUUID(), name, path: path.join(output, `project-${index}`), kind: 'local', unread: index === 1 ? 1 : 0, lastCompletedAt: index ? Date.now() : null, restore: { terminal: false, codex: false } }));
await fs.mkdir(profile, { recursive: true });
for (const project of projects) await fs.mkdir(path.join(project.path, 'docs'), { recursive: true });
const content = '# Project Grid\n\n清楚地看见每一个项目，随时接着工作。\n\n## 功能\n\n- **多终端分屏**：保留各自的输入与会话。\n- [x] 编辑文件\n- [ ] 查看结果\n\n> 按 Ctrl+S 保存，未保存的内容也可以预览。\n\n| 功能 | 状态 |\n| --- | --- |\n| 主题切换 | 可用 |\n| Markdown | 可用 |\n\n```ts\nconst message = "Hello, Project Grid";\nconsole.log(message);\n```\n\n![项目图标](../assets/icon.png)\n\n[打开说明](../note.txt) · [网页链接](https://example.com/docs) · [回到功能](#功能)\n';
for (const directory of [projects[0].path, ssh.project]) {
  await fs.mkdir(path.join(directory, 'assets'), { recursive: true }); await fs.mkdir(path.join(directory, 'docs'), { recursive: true });
  await fs.copyFile(path.join(root, 'assets/icon.png'), path.join(directory, 'assets/icon.png'));
  await fs.writeFile(path.join(directory, 'docs/README.md'), content);
  await fs.writeFile(path.join(directory, 'note.txt'), '普通文本打开即可编辑');
}
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { notifications: false, restoreSessions: false, closeToTray: false } }));
const env = { ...process.env, PROJECT_GRID_DATA_DIR: profile, PROJECT_GRID_TEST_SSH_CONFIG: ssh.configFile }; delete env.ELECTRON_RUN_AS_NODE; delete env.PROJECT_GRID_DEV_URL;
const packaged = process.argv.includes('--packaged');
let app, page;
async function waitFor(check, name) { const until = Date.now() + 20000; while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 60)); } throw new Error(`Timed out: ${name}`); }
const state = async () => (await page.evaluate(() => window.projectGrid.getState())).value;
async function launch() {
  app = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Project Grid.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env });
  page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: null });
  await app.evaluate(({ dialog, shell }) => { dialog.showMessageBox = async (_window, options) => ({ response: options.title === '未保存的修改' ? 2 : 1 }); globalThis.openedMarkdownLinks = []; shell.openExternal = async url => { globalThis.openedMarkdownLinks.push(url); }; });
  await page.waitForSelector('.project-panel');
}
async function chooseTheme(id, name) {
  await page.getByRole('button', { name: '工作台设置', exact: true }).click();
  const dialog = page.locator('dialog[open]');
  await dialog.getByText(name, { exact: true }).click();
  await waitFor(async () => page.evaluate(id => document.documentElement.dataset.theme === id, id), 'theme applied');
  assert.ok(await dialog.getByRole('radio', { name, exact: true }).isChecked());
  await page.screenshot({ path: path.join(output, `${id}-settings.png`) });
  await dialog.getByRole('button', { name: '关闭设置', exact: true }).click();
}
try {
  await launch();
  const first = page.locator(`[data-project-id="${projects[0].id}"]`);
  await first.getByRole('button', { name: '启动终端', exact: true }).click();
  await waitFor(async () => (await state()).projects[0].shellReady, 'shell ready');
  const sessionId = (await state()).projects[0].sessionId;
  await page.evaluate(id => window.projectGrid.writeTerminal(id, "Write-Host (([string][char]27) + '[31mRED ' + ([string][char]27) + '[32mGREEN ' + ([string][char]27) + '[34mBLUE' + ([string][char]27) + '[0m')\r"), projects[0].id);
  await waitFor(async () => first.locator('.xterm-rows > div').evaluateAll(rows => rows.some(row => row.textContent.trim() === 'RED GREEN BLUE')), 'ANSI colors');
  const colors = () => first.locator('.xterm-rows > div').evaluateAll(rows => [...rows.find(row => row.textContent.trim() === 'RED GREEN BLUE').querySelectorAll('span')].map(span => getComputedStyle(span).color));
  const originalColors = await colors();
  await first.locator('.terminal-host').evaluate(node => { globalThis.originalThemeTerminal = node; });
  await page.evaluate(id => window.projectGrid.writeTerminal(id, "Write-Output 'PENDING_THEME_DRAFT'"), projects[0].id);
  for (const [id, name] of [['mountain-blue', '山青蓝'], ['wild-red', '西野红'], ['forest', '林间光影']]) {
    await chooseTheme(id, name);
    assert.equal((await state()).projects[0].sessionId, sessionId);
    assert.ok(await first.locator('.terminal-host').evaluate(node => node === globalThis.originalThemeTerminal));
    assert.deepEqual(await colors(), originalColors);
    const signal = await page.locator(`[data-project-id="${projects[1].id}"]`).evaluate(node => getComputedStyle(node).getPropertyValue('--signal-rgb').trim());
    assert.equal(signal, '255, 134, 212');
    await page.screenshot({ path: path.join(output, `${id}-overview.png`) });
  }
  assert.ok((await page.evaluate(id => window.projectGrid.attachTerminal(id), projects[0].id)).value.data.includes('PENDING_THEME_DRAFT'));
  await chooseTheme('mountain-blue', '山青蓝');
  await first.getByRole('button', { name: `全屏查看 ${projects[0].name}`, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await page.getByRole('treeitem', { name: 'docs', exact: true }).click();
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文件编辑器', exact: true });
  await editor.waitFor(); assert.equal(await editor.inputValue(), content);
  const previewGeometry = await page.locator('.file-preview').evaluate(node => {
    const box = node.getBoundingClientRect(), footer = document.querySelector('.workspace-statusbar').getBoundingClientRect();
    return { gap: footer.top - box.bottom, margin: parseFloat(getComputedStyle(node).marginBottom), footerLeft: footer.left, footerRight: footer.right, width: innerWidth };
  });
  assert.ok(Math.abs(previewGeometry.gap - previewGeometry.margin) <= 1, 'preview has no obsolete extra footer gap');
  assert.ok(previewGeometry.footerLeft === 0 && previewGeometry.footerRight === previewGeometry.width, 'footer spans explorer and preview');
  assert.equal(await editor.evaluate(node => getComputedStyle(node).fontWeight), '600');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const markdown = page.getByRole('article', { name: 'Markdown 预览', exact: true });
  await markdown.getByRole('heading', { name: 'Project Grid', exact: true }).waitFor();
  assert.equal(await markdown.evaluate(node => getComputedStyle(node).fontWeight), '600');
  assert.equal(await markdown.locator('table tbody tr').count(), 2);
  assert.equal(await markdown.locator('pre code').count(), 1);
  assert.equal(await markdown.locator('input[type="checkbox"][disabled]').count(), 2);
  await waitFor(async () => markdown.getByAltText('项目图标').evaluate(image => image.complete && image.naturalWidth === 256), 'relative Markdown image');
  await page.screenshot({ path: path.join(output, 'markdown-mountain-blue.png') });
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const dirtyContent = content.replace('# Project Grid', '# 未保存的预览');
  await editor.fill(dirtyContent);
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await markdown.getByRole('heading', { name: '未保存的预览', exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(projects[0].path, 'docs/README.md'), 'utf8'), content);
  await chooseTheme('wild-red', '西野红');
  await markdown.getByRole('heading', { name: '未保存的预览', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'markdown-wild-red.png') });
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  assert.equal(await editor.inputValue(), dirtyContent);
  const unsafe = dirtyContent + '\n<script>globalThis.mdPwned=true</script>\n<style>html{display:none}</style>\n<iframe src="https://example.com"></iframe>\n<a href="javascript:globalThis.mdPwned=true">危险链接</a>\n<img src="missing.png" onerror="globalThis.mdPwned=true">\n<input autofocus onfocus="globalThis.mdPwned=true">\n';
  await editor.fill(unsafe); await page.getByRole('button', { name: '预览', exact: true }).click();
  await markdown.getByText('危险链接', { exact: true }).waitFor();
  assert.equal(await markdown.locator('script,style,iframe,[onerror],[onfocus],input:not([disabled])').count(), 0);
  assert.equal(await markdown.getByText('危险链接', { exact: true }).getAttribute('href'), null);
  assert.equal(await page.evaluate(() => globalThis.mdPwned), undefined);
  await page.getByRole('button', { name: '编辑', exact: true }).click(); await editor.fill(dirtyContent); await page.keyboard.press('Control+s');
  await waitFor(async () => (await fs.readFile(path.join(projects[0].path, 'docs/README.md'), 'utf8')) === dirtyContent, 'Markdown saved');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await markdown.getByRole('link', { name: '网页链接', exact: true }).click();
  await waitFor(async () => app.evaluate(() => globalThis.openedMarkdownLinks.includes('https://example.com/docs')), 'external Markdown link');
  await markdown.getByRole('link', { name: '打开说明', exact: true }).click();
  await waitFor(async () => (await editor.inputValue()) === '普通文本打开即可编辑', 'relative file link opens editable text');
  assert.equal(await page.getByRole('button', { name: '编辑', exact: true }).count(), 0);
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  const remoteId = (await page.evaluate(() => window.projectGrid.addSSHProject({ host: 'fixture', path: '/srv/fixture', name: '远程 Markdown' }))).value;
  await waitFor(async () => (await state()).projects.find(item => item.id === remoteId).shellReady, 'remote shell');
  await page.getByRole('button', { name: '全屏查看 远程 Markdown', exact: true }).click();
  await page.getByRole('treeitem', { name: 'docs', exact: true }).click(); await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await waitFor(async () => markdown.getByAltText('项目图标').evaluate(image => image.complete && image.naturalWidth === 256), 'SSH Markdown image');
  await page.getByRole('button', { name: '编辑', exact: true }).click(); await editor.fill('# SSH 保存成功'); await page.keyboard.press('Control+s');
  await waitFor(async () => (await fs.readFile(path.join(ssh.project, 'docs/README.md'), 'utf8')) === '# SSH 保存成功', 'SSH Markdown edit saves');
  await app.close(); app = null;
  await launch();
  assert.equal((await state()).settings.theme, 'wild-red');
  await waitFor(async () => page.evaluate(() => document.documentElement.dataset.theme === 'wild-red'), 'theme survives restart');
  console.log('PASS: three persistent themes preserve ANSI colors, task colors, terminal identity and drafts');
  console.log('PASS: automatic editing, local/SSH Markdown render and save, GFM, relative resources and links, and sanitized HTML');
  console.log(`Screenshots: ${output}`);
} catch (error) { if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { if (app) await app.close(); await ssh.close(); }
