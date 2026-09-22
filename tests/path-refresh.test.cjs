const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);

test('new Windows terminals supplement stale PATH without replacing inherited toolchains', { skip: process.platform !== 'win32' }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-grid-path-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(dir).startsWith('project-grid-path-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const cases = [
    { name: 'new tool', inherited: 'C:\\venv;C:\\System', Machine: 'C:\\System', User: 'C:\\Users\\测试 用户\\.mimocode\\bin', expected: 'C:\\venv;C:\\System;C:\\Users\\测试 用户\\.mimocode\\bin' },
    { name: 'deduplicate', inherited: 'C:\\Tools\\;"C:\\With Space";C:\\;C:', Machine: 'c:\\TOOLS;C:/With Space;;C:\\', User: ' C:\\New ', expected: 'C:\\Tools\\;"C:\\With Space";C:\\;C:;C:\\New' },
    { name: 'expand known only', inherited: 'C:\\preferred', Machine: '%PG_PATH_ROOT%\\bin', User: '%PROJECT_GRID_UNDEFINED_PATH_TEST%\\bin', expected: 'C:\\preferred;C:\\Known Root\\bin;%PROJECT_GRID_UNDEFINED_PATH_TEST%\\bin' },
    { name: 'machine denied', inherited: 'C:\\keep', Machine: 'C:\\ignored', User: 'C:\\UserTool', fail: 'Machine', expected: 'C:\\keep;C:\\UserTool' },
    { name: 'user denied', inherited: 'C:\\keep', Machine: 'C:\\MachineTool', User: 'C:\\ignored', fail: 'User', expected: 'C:\\keep;C:\\MachineTool' },
    { name: 'empty persistent paths', inherited: 'C:\\keep', Machine: '', User: null, expected: 'C:\\keep' },
    { name: 'reread', inherited: 'C:\\keep', Machine: '', User: '', nextUser: 'C:\\Installed Later', expected: 'C:\\keep', second: 'C:\\keep;C:\\Installed Later' },
    { name: 'path reference is bounded', inherited: 'C:\\keep', Machine: '', User: '%PATH%;C:\\new', expected: 'C:\\keep;C:\\new' },
  ];
  const file = path.join(dir, 'cases.json'); await fs.writeFile(file, JSON.stringify(cases));
  const { stdout } = await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'fixtures/path-refresh-check.ps1'), '-Script', path.join(__dirname, '../integration/refresh-path.ps1'), '-Cases', file], { windowsHide: true, timeout: 10000 });
  const results = JSON.parse(stdout);
  for (const [index, result] of results.entries()) {
    assert.equal(result.first, cases[index].expected, result.name);
    assert.equal(result.second, cases[index].second || cases[index].expected, `${result.name}: repeated refresh`);
    assert.deepEqual(result.reads, ['Machine', 'User', 'Machine', 'User']);
    assert.equal(result.kept, 'unchanged');
  }
});
