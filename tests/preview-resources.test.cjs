const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PreviewResources } = require('../electron/preview-resources.cjs');

async function setup(t) {
  const prefix = path.join(os.tmpdir(), 'project-grid-preview-');
  const directory = await fs.mkdtemp(prefix);
  const project = { id: 'project', path: path.join(directory, 'project') };
  await fs.mkdir(path.join(project.path, 'reports'), { recursive: true });
  await fs.mkdir(path.join(project.path, 'assets'));
  await fs.writeFile(path.join(project.path, 'reports', 'page.html'), '<h1>Hello</h1>');
  await fs.writeFile(path.join(project.path, 'assets', '图片 #1.png'), 'png fixture');
  await fs.writeFile(path.join(project.path, 'assets', 'style.css'), 'body{color:red}');
  t.after(async () => { const target = path.resolve(directory); assert.ok(target.startsWith(prefix)); await fs.rm(target, { recursive: true, force: true }); });
  return { directory, project, resources: new PreviewResources() };
}

test('HTML resources resolve relative and parent paths within the project', async t => {
  const { project, resources } = await setup(t);
  const view = resources.open(project, 'reports/page.html', 'html');
  const html = await resources.resolve(view.url);
  assert.match(html.mimeType, /^text\/html/);
  assert.ok(html.headers['Content-Security-Policy'].includes('sandbox allow-scripts allow-same-origin'));
  const css = await resources.resolve(new URL('../assets/style.css', view.url).href);
  assert.match(css.mimeType, /^text\/css/);
  const image = await resources.resolve(new URL('../assets/' + encodeURIComponent('图片 #1.png'), view.url).href);
  assert.equal(image.path, await fs.realpath(path.join(project.path, 'assets', '图片 #1.png')));
});

test('image capability only serves the selected image and expires on close', async t => {
  const { project, resources } = await setup(t);
  const view = resources.open(project, 'assets/图片 #1.png', 'image');
  assert.equal((await resources.resolve(view.url)).mimeType, 'image/png');
  await assert.rejects(resources.resolve(new URL('style.css', view.url).href));
  resources.close(view.previewId);
  await assert.rejects(resources.resolve(view.url), /expired/);
});

test('preview origins are unique and removing a project revokes its pages', async t => {
  const { project, resources } = await setup(t);
  const first = resources.open(project, 'reports/page.html', 'html');
  const second = resources.open(project, 'reports/page.html', 'html');
  assert.notEqual(new URL(first.url).hostname, new URL(second.url).hostname);
  assert.equal(resources.hasUrl(first.url), true);
  resources.closeProject(project.id);
  assert.equal(resources.hasUrl(first.url), false);
  await assert.rejects(resources.resolve(second.url), /expired/);
});

test('project secrets, unsupported resources and external symlinks are rejected', async t => {
  const { directory, project, resources } = await setup(t);
  await fs.mkdir(path.join(project.path, '.codex'));
  await fs.writeFile(path.join(project.path, '.codex', 'auth.json'), '{}');
  await fs.writeFile(path.join(project.path, 'command.ps1'), 'whoami');
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'data.json'), '{}');
  await fs.symlink(outside, path.join(project.path, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  const view = resources.open(project, 'reports/page.html', 'html');
  for (const relative of ['../.codex/auth.json', '../command.ps1', '../external/data.json', '../C%3A/Windows/test.png', '../assets/%2e%2e%2f%2e%2e%2foutside/data.json']) {
    await assert.rejects(resources.resolve(new URL(relative, view.url).href));
  }
});

test('explicit previews in a hidden output folder can load their own assets', async t => {
  const { project, resources } = await setup(t);
  await fs.mkdir(path.join(project.path, '.test-output'));
  await fs.writeFile(path.join(project.path, '.test-output', 'report.html'), '<h1>Report</h1>');
  await fs.writeFile(path.join(project.path, '.test-output', 'preview.png'), 'image');
  const view = resources.open(project, '.test-output/report.html', 'html');
  assert.match((await resources.resolve(view.url)).mimeType, /^text\/html/);
  assert.equal((await resources.resolve(new URL('preview.png', view.url).href)).mimeType, 'image/png');
});
