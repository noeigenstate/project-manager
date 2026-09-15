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

test('turn completion is unread, deduplicated, and survives restarting the app', t => {
  const { store, project, file } = fixture(t);
  assert.equal(store.complete(project.id, 'thread:turn1', 1700000000000), true);
  assert.equal(store.complete(project.id, 'thread:turn1'), false);
  assert.equal(store.complete(project.id, 'thread:turn2', 1700000001000), true);
  const restored = new WorkspaceStore(file);
  assert.equal(restored.projects[0].unread, 2);
  assert.equal(restored.projects[0].lastCompletedAt, 1700000001000);
  assert.equal(restored.complete(project.id, 'thread:turn2'), false);
});

test('viewing a round does not mark the project finished; manual finish is green', t => {
  const { store, project, file } = fixture(t);
  store.complete(project.id, 'thread:turn1');
  store.acknowledge(project.id);
  assert.equal(project.unread, 0);
  assert.equal(project.done, false);
  store.markDone(project.id, true);
  assert.equal(new WorkspaceStore(file).projects[0].done, true);
  store.markDone(project.id, false);
  assert.equal(project.done, false);
});

test('a genuinely new round can make a previously completed project need attention', t => {
  const { store, project } = fixture(t);
  store.markDone(project.id, true);
  store.complete(project.id, 'thread:turn-new');
  assert.equal(project.done, false);
  assert.equal(project.unread, 1);
});

test('unknown projects and invalid event identifiers do not create completion', t => {
  const { store, project } = fixture(t);
  assert.equal(store.complete('other', 'turn'), false);
  assert.equal(store.complete(project.id, ''), false);
  assert.equal(store.complete(project.id, {}), false);
  assert.equal(project.unread, 0);
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
  assert.deepEqual(cleanSettings({ columns: 999, fontSize: -2, notifications: 'yes', sound: false }), { columns: 0, fontSize: 12, notifications: true, sound: false, closeToTray: true, explorerCollapsed: false, restoreSessions: true });
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

test('older workspace records migrate without losing completion markers or guessing a terminal state', t => {
  const { file, projectDir } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects: [{ id: 'legacy', name: '旧项目', path: projectDir, done: true, unread: 0 }], settings: {} }));
  const store = new WorkspaceStore(file);
  assert.equal(store.projects[0].kind, 'local');
  assert.equal(store.projects[0].restore, null);
  assert.equal(store.projects[0].done, true);
  assert.equal(store.settings.restoreSessions, true);
});
