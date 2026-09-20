const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PreviewResources, resourceResponse } = require('../electron/preview-resources.cjs');

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

test('Markdown resource capabilities allow project images but not scripts or documents', async t => {
  const { project, resources } = await setup(t);
  await fs.writeFile(path.join(project.path, 'reports', 'README.md'), '# Markdown');
  await fs.writeFile(path.join(project.path, 'assets', 'code.js'), 'alert(1)');
  const view = resources.open(project, 'reports/README.md', 'markdown');
  assert.equal((await resources.resolve(new URL('../assets/' + encodeURIComponent('图片 #1.png'), view.url).href)).mimeType, 'image/png');
  await assert.rejects(resources.resolve(new URL('../assets/code.js', view.url).href));
  await assert.rejects(resources.resolve(view.url));
  resources.close(view.previewId);
  await assert.rejects(resources.resolve(new URL('../assets/' + encodeURIComponent('图片 #1.png'), view.url).href));
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

test('video seeking serves byte ranges and expires access to the selected file', async t => {
  const { project, resources } = await setup(t);
  await fs.writeFile(path.join(project.path, 'clip.mp4'), Buffer.from('0123456789'));
  const view = resources.open(project, 'clip.mp4', 'video');
  const resource = await resources.resolve(view.url);
  assert.equal(resource.mimeType, 'video/mp4');
  for (const [range, content, contentRange] of [['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-3', '789', 'bytes 7-9/10']]) {
    const response = resourceResponse(resource, new Request(view.url, { headers: { Range: range } }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), contentRange);
    assert.equal(response.headers.get('Content-Length'), String(content.length));
    assert.equal(await response.text(), content);
  }
  for (const range of ['bytes=100-', 'bytes=5-2', 'bytes=-0']) {
    const response = resourceResponse(resource, new Request(view.url, { headers: { Range: range } }));
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('Content-Range'), 'bytes */10');
  }
  const head = resourceResponse(resource, new Request(view.url, { method: 'HEAD' }));
  assert.equal(head.headers.get('Content-Length'), '10');
  assert.equal(await head.text(), '');
  const full = resourceResponse(resource, new Request(view.url));
  assert.equal(await full.text(), '0123456789');
  await assert.rejects(resources.resolve(new URL('assets/style.css', view.url).href));
  resources.close(view.previewId);
  await assert.rejects(resources.resolve(view.url));
});

test('content-identified images retain the correct MIME type without a filename extension', async t => {
  const { project, resources } = await setup(t);
  await fs.writeFile(path.join(project.path, 'download'), 'image');
  const view = resources.open(project, 'download', 'image', 'image/png');
  assert.equal((await resources.resolve(view.url)).mimeType, 'image/png');
});

test('resources above 128 MiB stream the requested tail without loading the whole file', async t => {
  const { project, resources } = await setup(t);
  const size = 129 * 1024 * 1024;
  const handle = await fs.open(path.join(project.path, 'large.webm'), 'w');
  await handle.write(Buffer.from('TAIL'), 0, 4, size - 4);
  await handle.close();
  const view = resources.open(project, 'large.webm', 'video');
  const resource = await resources.resolve(view.url);
  assert.equal(resource.size, size);
  const response = resourceResponse(resource, new Request(view.url, { headers: { Range: 'bytes=-4' } }));
  assert.equal(response.status, 206);
  assert.equal(await response.text(), 'TAIL');
});
