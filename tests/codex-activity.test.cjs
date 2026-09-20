const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CodexActivityReader, monitorActivity } = require('../electron/codex-activity.cjs');
const { TerminalTitleTracker } = require('../electron/terminal-title.cjs');
const line = value => JSON.stringify(value) + '\n';
const event = (type, turn) => line({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: turn } });

test('two terminals in the same folder bind to different Codex session titles', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-two-sessions-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'sessions'));
  const ids = [randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) await fs.writeFile(path.join(home, 'sessions', `rollout-${id}.jsonl`), line({ type: 'session_meta', payload: { id, cwd: home, source: 'cli' } }) + event('task_started', id) + (index ? event('task_complete', id) : ''));
  const left = new CodexActivityReader(home, home, Date.now(), { threadId: () => ids[0], requireBinding: () => true });
  const right = new CodexActivityReader(home, home, Date.now(), { threadId: () => ids[1], requireBinding: () => true });
  assert.equal((await left.read()).state, 'working');
  assert.equal((await right.read()).state, 'complete');
  const unbound = new CodexActivityReader(home, home, Date.now(), { requireBinding: () => true });
  assert.equal(await unbound.read(), null);
  const titles = new TerminalTitleTracker();
  assert.deepEqual(titles.write('\x1b]0;' + ids[0].slice(0, 15)), []);
  assert.deepEqual(titles.write(ids[0].slice(15) + '\x07' + 'output'.repeat(20000)), [ids[0]]);
  assert.deepEqual(titles.write('\x1b]2;' + ids[1] + '\x1b\\'), [ids[1]]);
  assert.deepEqual(titles.write('normal output ' + ids[0]), []);
});

test('a child completion and stale turn never complete the interactive parent', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-activity-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const directory = path.join(home, 'sessions'); await fs.mkdir(directory);
  const thread = randomUUID(), child = randomUUID();
  const file = path.join(directory, `rollout-${thread}.jsonl`);
  await fs.writeFile(file, line({ type: 'session_meta', payload: { id: thread, cwd: home, source: 'cli' } }) + event('task_started', 'parent-turn'));
  await fs.writeFile(path.join(directory, `rollout-${child}.jsonl`), line({ type: 'session_meta', payload: { id: child, cwd: home, source: { subagent: 'parent' } } }) + event('task_started', 'child-turn') + event('task_complete', 'child-turn'));
  const reader = new CodexActivityReader(home, home, Date.now() - 1000);
  assert.equal((await reader.read()).state, 'working');
  assert.equal(reader.snapshot.threadId, thread);
  const offset = reader.offset;
  await reader.read(); assert.equal(reader.offset, offset, 'idle polling does not reread history');
  await fs.appendFile(file, event('task_complete', 'older-turn'));
  assert.equal((await reader.read()).state, 'working');
  const completion = event('task_complete', 'parent-turn');
  await fs.appendFile(file, completion.slice(0, -1));
  assert.equal((await reader.read()).state, 'working', 'a partial record is not a completion');
  await fs.appendFile(file, '\n');
  assert.equal((await reader.read()).state, 'complete');
  await fs.appendFile(file, event('task_started', 'next-turn') + event('turn_aborted', 'next-turn'));
  assert.equal((await reader.read()).state, 'interrupted');
});

test('oversized output remains bounded and cannot hide later lifecycle events', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-large-activity-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'sessions'));
  const thread = randomUUID(), file = path.join(home, 'sessions', `rollout-${thread}.jsonl`);
  await fs.writeFile(file, line({ type: 'session_meta', payload: { id: thread, cwd: home, source: 'cli' } }) + event('task_started', 'turn') + line({ type: 'response_item', payload: 'x'.repeat(5 * 1024 * 1024) }) + event('task_complete', 'turn'));
  const reader = new CodexActivityReader(home, home, Date.now());
  assert.equal(await reader.read(), null, 'only caught-up snapshots are published');
  assert.ok(reader.buffer.length <= 1024 * 1024);
  assert.equal((await reader.read()).state, 'complete');
});

test('monitor coalesces slow reads, deduplicates snapshots, and cancels late responses', async () => {
  let resolve, reads = 0, changed = 0;
  const monitor = monitorActivity(() => { reads++; return new Promise(done => { resolve = done; }); }, () => changed++, { interval: 10000 });
  const first = monitor.poll(), second = monitor.poll();
  assert.equal(first, second);
  await Promise.resolve(); assert.equal(reads, 1);
  resolve({ state: 'working' }); await first; assert.equal(changed, 1);
  const third = monitor.poll(); await Promise.resolve();
  resolve({ state: 'working' }); await third; assert.equal(changed, 1);
  const late = monitor.poll(); await Promise.resolve(); monitor.stop();
  resolve({ state: 'complete' }); await late;
  assert.equal(changed, 1);
  await monitor.poll(); assert.equal(reads, 3);
});
