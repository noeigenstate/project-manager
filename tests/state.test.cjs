const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceStore, cleanSettings } = require('../electron/state.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-grid-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectDir = path.join(directory, "中文项目 & 空格 [a] 'b' $c");
  fs.mkdirSync(projectDir);
  const file = path.join(directory, 'workspace.json');
  const store = new WorkspaceStore(file);
  const { project } = store.add(projectDir);
  return { directory, projectDir, file, store, project };
}

test('adding the same real folder twice keeps one project', t => {
  const { store, projectDir, project } = fixture(t);
  const second = store.add(path.join(projectDir, '.'));
  assert.equal(second.added, false);
  assert.equal(second.project.id, project.id);
  assert.equal(store.projects.length, 1);
});

test('Windows transient save locks retry atomically and persistent failures remain explicit', { skip: process.platform !== 'win32' }, t => {
  const { file, store, project } = fixture(t);
  const rename = fs.renameSync; let attempts = 0, locked = 2;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === file && attempts++ < locked) { const error = new Error('file temporarily locked'); error.code = 'EBUSY'; throw error; }
    return rename(source, target);
  });
  store.setRestore(project.id, { terminal: true, threadId: '00000000-0000-4000-8000-000000000003' });
  assert.equal(attempts, 3);
  assert.equal(new WorkspaceStore(file).projects[0].restore.threadId, '00000000-0000-4000-8000-000000000003');
  assert.equal(fs.existsSync(file + '.tmp'), false);
  const previous = fs.readFileSync(file, 'utf8'); attempts = 0; locked = Infinity;
  assert.throws(() => store.save(), /temporarily locked/);
  assert.equal(attempts, 5); assert.equal(fs.readFileSync(file, 'utf8'), previous);
});

test('extra terminals keep independent recovery identities and closing one preserves the others', t => {
  const { store, project, file } = fixture(t);
  const first = store.addTerminal(project.id), second = store.addTerminal(project.id);
  const thread = '00000000-0000-4000-8000-000000000001';
  store.setRestore(first, { codex: true, threadId: thread });
  const reopened = new WorkspaceStore(file);
  assert.equal(reopened.findTerminal(first).record.restore.threadId, thread);
  assert.equal(reopened.findTerminal(second).record.restore.codex, false);
  reopened.removeTerminal(first);
  assert.equal(reopened.findTerminal(first), null);
  assert.equal(reopened.findTerminal(second).project.id, project.id);
  reopened.removeTerminal(project.id);
  assert.equal(reopened.findTerminal(second).record.restore.terminal, true);
  assert.equal(reopened.projects[0].primaryTerminalClosed, true);
  reopened.setRestore(project.id, { terminal: true });
  assert.equal(new WorkspaceStore(file).projects[0].primaryTerminalClosed, false);
});

test('turn completion is unread, deduplicated, and survives restarting the app', t => {
  const { store, project, file } = fixture(t);
  store.expectCompletion(project.id);
  assert.equal(store.complete(project.id, 'thread:turn1', 1700000000000), true);
  assert.equal(store.complete(project.id, 'thread:turn1'), false);
  store.expectCompletion(project.id);
  assert.equal(store.complete(project.id, 'thread:turn2', 1700000001000), true);
  const restored = new WorkspaceStore(file);
  assert.equal(restored.projects[0].unread, 2);
  assert.equal(restored.projects[0].lastCompletedAt, 1700000001000);
  assert.equal(restored.complete(project.id, 'thread:turn2'), false);
});

test('viewing a round clears unread without introducing a manual completion flag', t => {
  const { store, project, file } = fixture(t);
  store.expectCompletion(project.id);
  store.complete(project.id, 'thread:turn1');
  store.acknowledge(project.id);
  assert.equal(project.unread, 0);
  assert.equal('done' in project, false);
  assert.equal('done' in new WorkspaceStore(file).projects[0], false);
});

test('a genuinely new round can make a previously viewed round need attention', t => {
  const { store, project } = fixture(t);
  store.expectCompletion(project.id); store.complete(project.id, 'previous-turn'); store.acknowledge(project.id);
  store.expectCompletion(project.id);
  store.complete(project.id, 'thread:turn-new');
  assert.equal(project.unread, 1);
});

test('unknown projects and invalid event identifiers do not create completion', t => {
  const { store, project } = fixture(t);
  assert.equal(store.complete('other', 'turn'), false);
  assert.equal(store.complete(project.id, ''), false);
  assert.equal(store.complete(project.id, {}), false);
  assert.equal(project.unread, 0);
});

test('idle callbacks with different IDs never repeat an alert, even after viewing or restarting', t => {
  const { store, project, file } = fixture(t);
  assert.equal(store.complete(project.id, 'background-before-input'), false);
  store.expectCompletion(project.id);
  assert.equal(store.complete(project.id, 'main:first', 1000), true);
  assert.equal(store.complete(project.id, 'background:second', 60000), false);
  assert.equal(store.complete(project.id, 'different-thread:third', 3600000), false);
  assert.equal(project.unread, 1); assert.equal(project.lastCompletedAt, 1000);
  store.acknowledge(project.id);
  assert.equal(store.complete(project.id, 'after-viewing', 7200000), false);
  const restored = new WorkspaceStore(file);
  assert.equal(restored.complete(project.id, 'after-restart', 86400000), false);
  assert.equal(restored.projects[0].unread, 0);
  assert.equal(restored.projects[0].lastCompletedAt, 1000);
  restored.expectCompletion(project.id);
  assert.equal(restored.complete(project.id, 'background:second'), false, 'previously ignored events cannot consume a fresh submission');
  assert.equal(restored.complete(project.id, 'main:new-input', 86401000), true);
  assert.equal(restored.complete(project.id, 'background:new-ID', 86402000), false);
  assert.equal(restored.projects[0].unread, 1);
});

test('pending input survives restart; cancelling it closes the alert until another submission', t => {
  const { store, project, file } = fixture(t);
  store.expectCompletion(project.id);
  const restored = new WorkspaceStore(file);
  assert.equal(restored.complete(project.id, 'pending-work'), true);
  restored.expectCompletion(project.id);
  restored.expectCompletion(project.id, false);
  assert.equal(restored.complete(project.id, 'late-background-work'), false);
  restored.expectCompletion(project.id);
  assert.equal(restored.complete(project.id, 'new-instruction'), true);
});

test('migrating a previous workspace does not rearm idle completion notifications', t => {
  const { file, projectDir } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ version: 2, projects: [{ id: 'legacy', name: 'Idle project', path: projectDir, unread: 1, lastCompletedAt: 1000, seenEvents: ['old-turn'] }], settings: {} }));
  const restored = new WorkspaceStore(file);
  assert.equal(restored.complete('legacy', 'fresh-background-id', 9000000), false);
  assert.equal(restored.projects[0].unread, 1);
  assert.equal(restored.projects[0].lastCompletedAt, 1000);
});

test('removing a project preserves all project files', t => {
  const { store, project, projectDir } = fixture(t);
  const source = path.join(projectDir, 'keep.txt');
  fs.writeFileSync(source, 'keep this');
  store.remove(project.id);
  assert.equal(store.projects.length, 0);
  assert.equal(fs.readFileSync(source, 'utf8'), 'keep this');
});

test('corrupt workspace is copied aside before a new workspace can be saved', t => {
  const { file, directory } = fixture(t);
  fs.writeFileSync(file, '{ invalid');
  const store = new WorkspaceStore(file);
  assert.ok(store.warning);
  const backups = fs.readdirSync(directory).filter(x => x.includes('.unreadable-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(directory, backups[0]), 'utf8'), '{ invalid');
});

test('settings reject invalid layout and font values', () => {
  assert.deepEqual(cleanSettings({ columns: 999, fontSize: -2, notifications: 'yes', sound: false }), { columns: 0, fontSize: 12, focusAnimation: 'smooth', theme: 'forest', notifications: true, sound: false, closeToTray: true, explorerCollapsed: false, restoreSessions: true });
  assert.equal(cleanSettings({ focusAnimation: 'invalid' }).focusAnimation, 'smooth');
  assert.equal(cleanSettings({ focusAnimation: 'system' }).focusAnimation, 'system');
  assert.equal(cleanSettings({ focusAnimation: 'off' }).focusAnimation, 'off');
});

test('SSH projects retain their host, remote path and recovery state without becoming local folders', t => {
  const { store, file } = fixture(t);
  const { project } = store.addSSH({ host: 'linux-dev', path: '~/apps/demo', name: '远程项目' });
  store.setRestore(project.id, { terminal: true, codex: true, cwd: '/home/dev/apps/demo/subdir' });
  const restored = new WorkspaceStore(file).projects.find(item => item.id === project.id);
  assert.equal(restored.kind, 'ssh');
  assert.equal(restored.path, '~/apps/demo');
  assert.equal(restored.ssh.host, 'linux-dev');
  assert.deepEqual(restored.restore, { terminal: true, codex: true, cwd: '/home/dev/apps/demo/subdir' });
  assert.equal(store.addSSH({ host: 'linux-dev', path: '~/apps/demo' }).added, false);
  assert.equal(store.addSSH({ host: 'other-host', path: '~/apps/demo' }).added, true);
});

test('legacy manual completion migrates to stopped recovery without retaining the removed flag', t => {
  const { file, projectDir } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects: [{ id: 'legacy', name: '旧项目', path: projectDir, done: true, unread: 0 }], settings: {} }));
  const store = new WorkspaceStore(file);
  assert.equal(store.projects[0].kind, 'local');
  assert.deepEqual(store.projects[0].restore, { terminal: false, codex: false });
  assert.equal('done' in store.projects[0], false);
  assert.equal(store.settings.restoreSessions, true);
  store.save();
  assert.equal('done' in JSON.parse(fs.readFileSync(file, 'utf8')).projects[0], false);
  assert.equal(new WorkspaceStore(file).projects[0].restore.terminal, false);
});

test('removing manual completion keeps every legacy local/SSH split stopped and preserves session identity', t => {
  const { file, projectDir } = fixture(t);
  const thread = '00000000-0000-4000-8000-000000000001';
  const split = '00000000-0000-4000-8000-000000000002';
  for (const kind of ['local', 'ssh']) {
    const cwd = kind === 'ssh' ? '/srv/project' : projectDir;
    const restore = { terminal: true, codex: true, cwd, threadId: thread };
    fs.writeFileSync(file, JSON.stringify({ version: 2, projects: [
      { id: 'legacy', kind, path: cwd, ...(kind === 'ssh' ? { ssh: { host: 'dev-host' } } : {}), done: true, completionArmed: true, lastCompletedAt: 1234, seenEvents: ['old-turn'], restore, terminals: [{ id: split, restore }] },
      { id: 'ordinary', path: projectDir, restore: { terminal: true, codex: true, cwd: projectDir } },
      { id: 'older', path: projectDir },
    ] }));
    const store = new WorkspaceStore(file), project = store.projects[0];
    assert.equal(project.primaryTerminalClosed, false, 'stopped legacy primary remains available to start manually');
    for (const record of [project, ...project.terminals]) assert.deepEqual(record.restore, { ...restore, terminal: false, codex: false });
    assert.equal(project.completionArmed, false); assert.equal(project.lastCompletedAt, 1234); assert.deepEqual(project.seenEvents, ['old-turn']);
    assert.equal(store.projects[1].restore.terminal, true); assert.equal(store.projects[2].restore, null);
    store.save(); assert.equal(new WorkspaceStore(file).projects[0].terminals[0].restore.terminal, false);
    store.setRestore(split, { terminal: true, codex: false });
    const reopened = new WorkspaceStore(file);
    assert.equal(reopened.projects[0].restore.terminal, false);
    assert.deepEqual(reopened.findTerminal(split).record.restore, { ...restore, terminal: true, codex: false });
  }
});

test('swapping project positions persists order and preserves local/SSH state', t => {
  const { store, project, file } = fixture(t);
  const middle = store.addSSH({ host: 'linux-middle', path: '/srv/middle' }).project;
  const last = store.addSSH({ host: 'linux-last', path: '/srv/last' }).project;
  store.expectCompletion(project.id); store.complete(project.id, 'turn-1');
  store.setRestore(project.id, { terminal: true, codex: true });
  store.swapProjects(project.id, last.id);
  assert.deepEqual(store.projects, [last, middle, project]);
  assert.deepEqual(new WorkspaceStore(file).projects.map(item => item.id), [last.id, middle.id, project.id]);
  assert.equal(project.unread, 1); assert.equal(last.restore.terminal, false); assert.equal(project.restore.codex, true);
  const before = fs.readFileSync(file, 'utf8');
  store.swapProjects(project.id, project.id);
  assert.throws(() => store.swapProjects('missing', last.id), /项目不存在/);
  assert.throws(() => store.swapProjects(project.id, null), /项目不存在/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('insertion reorder preserves all records and rejects stale or duplicated project lists', t => {
  const { store, project, file } = fixture(t);
  const second = store.addSSH({ host: 'two', path: '/srv/two' }).project;
  const third = store.addSSH({ host: 'three', path: '/srv/three' }).project;
  store.expectCompletion(project.id); store.complete(project.id, 'pending-turn');
  store.reorderProjects([second.id, third.id, project.id]);
  assert.deepEqual(new WorkspaceStore(file).projects.map(item => item.id), [second.id, third.id, project.id]);
  assert.equal(store.projects[2], project); assert.equal(project.unread, 1);
  for (const order of [[second.id, project.id], [second.id, project.id, project.id], [second.id, third.id, 'missing'], null]) assert.throws(() => store.reorderProjects(order), /项目列表已变化/);
});
