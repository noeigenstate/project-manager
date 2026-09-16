import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Exercise authenticated shell events and real rollout reads without a model.
// The shell remains occupied until the test observes completion, then exits.
export async function runDesktopTask(page, project, home, turn, waitFor) {
  const directory = path.join(home, 'sessions'); await fs.mkdir(directory, { recursive: true });
  const thread = randomUUID(), filename = path.join(directory, `rollout-${thread}.jsonl`);
  const release = path.join(project.path, `.task-${thread}.done`);
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const command = `$env:CODEX_HOME=${quote(home)}; Send-ProjectGridEvent 'codex-started'; for ($pgIndex=0; $pgIndex -lt 200 -and -not (Test-Path -LiteralPath ${quote(release)}); $pgIndex++) { Start-Sleep -Milliseconds 50 }; Send-ProjectGridEvent 'codex-exited'\r`;
  const state = async () => (await page.evaluate(() => window.projectGrid.getState())).value.projects.find(item => item.id === project.id);
  const previous = (await state()).lastCompletedAt;
  await page.evaluate(({ id, command }) => window.projectGrid.writeTerminal(id, command), { id: project.id, command });
  await waitFor(async () => (await state()).codexActive, 'offline task starts');
  const stamp = new Date().toISOString();
  await fs.writeFile(filename, [
    { type: 'session_meta', payload: { id: thread, cwd: project.path, source: 'cli' } },
    { type: 'event_msg', timestamp: stamp, payload: { type: 'task_started', turn_id: turn } },
    { type: 'event_msg', timestamp: stamp, payload: { type: 'task_complete', turn_id: turn } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  try { await waitFor(async () => (await state()).lastCompletedAt !== previous, 'interactive parent task completion'); }
  finally { await fs.writeFile(release, 'done'); }
  await waitFor(async () => (await state()).shellReady, 'offline task returns to shell');
}
