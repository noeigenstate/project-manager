const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { recentSession, resumeCommand } = require('../electron/session-restore.cjs');

async function setup(t) {
  const prefix = path.join(os.tmpdir(), 'project-grid-resume-');
  const folder = await fs.mkdtemp(prefix);
  await fs.mkdir(path.join(folder, 'sessions'), { recursive: true });
  await fs.mkdir(path.join(folder, 'project'));
  t.after(async () => { assert.ok(path.resolve(folder).startsWith(prefix)); await fs.rm(folder, { recursive: true, force: true }); });
  return { folder, project: path.join(folder, 'project') };
}

async function rollout(folder, cwd, events, source = 'cli', name = randomUUID()) {
  const id = randomUUID();
  const lines = [{ type: 'session_meta', payload: { id, cwd, source } }, ...events];
  const filename = path.join(folder, 'sessions', `rollout-${name}.jsonl`);
  await fs.writeFile(filename, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return { id, filename };
}
const event = type => ({ type: 'event_msg', payload: { type } });

test('resume chooses the newest interactive session for the correct working directory', async t => {
  const { folder, project } = await setup(t);
  const old = await rollout(folder, project, [event('task_started'), event('task_complete')], 'cli', 'older');
  await fs.utimes(old.filename, new Date(1000), new Date(1000));
  const latest = await rollout(folder, project, [event('task_started'), event('turn_aborted')]);
  await rollout(folder, path.join(folder, 'different-project'), [event('task_started')]);
  await rollout(folder, project, [event('task_started')], 'exec');
  await rollout(folder, project, [event('task_started')], { subagent: 'worker' });
  const result = await recentSession(project, folder);
  assert.equal(result.id, latest.id);
  assert.equal(result.state, 'interrupted');
  assert.equal(resumeCommand(result, true), `codex resume ${latest.id} "继续"\r`);
});

test('completed and unknown sessions are resumed without submitting a fresh instruction', async t => {
  const { folder, project } = await setup(t);
  await rollout(folder, project, [event('task_started'), event('task_complete')]);
  const result = await recentSession(project, folder);
  assert.equal(result.state, 'complete');
  assert.equal(resumeCommand(result, true), `codex resume ${result.id}\r`);
  assert.equal(resumeCommand({ id: result.id, state: 'unknown' }, true), `codex resume ${result.id}\r`);
  assert.equal(resumeCommand(null, false), null);
  assert.equal(resumeCommand(null, true), 'codex resume --last\r');
});

test('large transcript messages and a truncated final line do not hide a completed turn', async t => {
  const { folder, project } = await setup(t);
  const entry = await rollout(folder, project, [event('task_started'), { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'x'.repeat(2 * 1024 * 1024) } }, event('task_complete')]);
  await fs.appendFile(entry.filename, '{"truncated":');
  assert.equal((await recentSession(project, folder)).state, 'complete');
});

test('a crash after a task starts is continued, but unsafe session identifiers are rejected', async t => {
  const { folder, project } = await setup(t);
  await rollout(folder, project, [event('task_started'), event('agent_reasoning')]);
  assert.equal((await recentSession(project, folder)).state, 'interrupted');
  assert.throws(() => resumeCommand({ id: 'bad; command', state: 'interrupted' }, true));
});
