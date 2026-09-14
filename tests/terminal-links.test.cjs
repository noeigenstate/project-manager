const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { findLinkCandidates, readLogicalLine } = require('../src/terminal-links.ts');
const { resolveTerminalLink } = require('../electron/terminal-links.cjs');

test('terminal links include URLs, Markdown, quoted paths and file line references', () => {
  const values = findLinkCandidates('网页 https://example.com/report_(final)?x=1。 [报告](reports/中文 报告.html) `C:\\项目 空格\\截图.png` src/App.tsx:42:3 www.example.org');
  assert.deepEqual(values.map(value => value.target), ['https://example.com/report_(final)?x=1', 'reports/中文 报告.html', 'C:\\项目 空格\\截图.png', 'src/App.tsx:42:3', 'www.example.org']);
  assert.equal(findLinkCandidates('See (http://localhost:5178/preview).')[0].target, 'http://localhost:5178/preview');
  assert.equal(findLinkCandidates('See [report](reports/report_(final).html)')[0].target, 'reports/report_(final).html');
});

test('terminal link cells account for Chinese widths and wrapped rows', () => {
  const rows = [
    [{ chars: '图', width: 2 }, { chars: '', width: 0 }, ...[...' https:/'].map(chars => ({ chars, width: 1 }))],
    [...'/a.co/x'.split('').map(chars => ({ chars, width: 1 }))],
  ];
  const buffer = { getLine(index) { const cells = rows[index]; return cells && { isWrapped: index > 0, length: cells.length, getCell: col => cells[col] && { getChars: () => cells[col].chars, getWidth: () => cells[col].width }, translateToString: () => cells.filter(cell => cell.width > 0).map(cell => cell.chars).join('') }; } };
  const result = readLogicalLine(buffer, 10, 2);
  assert.equal(result.text, '图 https://a.co/x');
  const link = findLinkCandidates(result.text)[0];
  assert.deepEqual(result.starts[link.start], { x: 4, y: 1 });
  assert.deepEqual(result.ends[link.end - 1], { x: 7, y: 2 });
});

test('link resolution opens HTTP URLs and project files while rejecting executable protocols and escapes', async t => {
  const prefix = path.join(os.tmpdir(), 'project-grid-links-');
  const directory = await fs.mkdtemp(prefix);
  const project = { path: path.join(directory, 'project') };
  await fs.mkdir(project.path);
  t.after(async () => { const target = path.resolve(directory); assert.ok(target.startsWith(prefix)); await fs.rm(target, { recursive: true, force: true }); });
  const filename = path.join(project.path, '中文 图片.png');
  await fs.writeFile(filename, 'image');
  for (const target of ['中文 图片.png', filename, pathToFileURL(filename).href, '中文 图片.png:12:4']) {
    assert.deepEqual(await resolveTerminalLink(project, target), { kind: 'file', path: '中文 图片.png' });
  }
  assert.deepEqual(await resolveTerminalLink(project, 'http://localhost:5178/'), { kind: 'external', url: 'http://localhost:5178/' });
  assert.deepEqual(await resolveTerminalLink(project, 'www.example.org'), { kind: 'external', url: 'https://www.example.org/' });
  await fs.writeFile(path.join(directory, 'outside.txt'), 'private');
  for (const target of ['javascript:alert(1)', 'data:text/html,hi', 'vscode://test', 'powershell:command', '../outside.txt', pathToFileURL(path.join(directory, 'outside.txt')).href, 'bad\0path', '中文 图片.png:stream']) {
    await assert.rejects(resolveTerminalLink(project, target), target);
  }
});
