const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function* records(filename) {
  let buffer = Buffer.alloc(0); let skipping = false;
  for await (const chunk of fs.createReadStream(filename, { highWaterMark: 64 * 1024 })) {
    buffer = Buffer.concat([buffer, chunk]);
    let index;
    while ((index = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, index);
      buffer = buffer.subarray(index + 1);
      if (!skipping && line.length <= 1024 * 1024) { try { yield JSON.parse(line.toString('utf8')); } catch { } }
      skipping = false;
    }
    if (buffer.length > 1024 * 1024) { buffer = Buffer.alloc(0); skipping = true; }
  }
  if (buffer.length && !skipping) { try { yield JSON.parse(buffer.toString('utf8')); } catch { } }
}

function sameDirectory(a, b) {
  if (typeof a !== 'string') return false;
  const normalize = value => { let result; try { result = fs.realpathSync(value); } catch { result = path.resolve(value); } return process.platform === 'win32' ? result.toLowerCase() : result; };
  return normalize(a) === normalize(b);
}

function advanceTaskState(state, record) {
  const item = record.payload || {};
  if (record.type === 'event_msg') {
    if (['task_started', 'turn_started', 'user_message', 'turn_aborted', 'turn_interrupted'].includes(item.type)) return 'interrupted';
    if (['task_complete', 'turn_completed'].includes(item.type)) return 'complete';
  }
  if (record.type === 'response_item' && item.type === 'message') {
    if (item.role === 'user') return 'interrupted';
    if (item.role === 'assistant' && item.phase === 'final') return 'complete';
  }
  return state;
}

async function recentSession(projectPath, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const directory = path.join(codexHome, 'sessions');
  const files = [];
  async function visit(folder) {
    let entries; try { entries = await fsp.readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        try { files.push({ filename, modifiedAt: (await fsp.stat(filename)).mtimeMs }); } catch { }
      }
    }
  }
  await visit(directory);
  files.sort((a, b) => b.modifiedAt - a.modifiedAt);
  for (const file of files) {
    try {
      let meta = null; let state = 'unknown';
      for await (const record of records(file.filename)) {
        if (!meta) {
          if (record.type !== 'session_meta' || !['cli', 'vscode'].includes(record.payload?.source || 'cli') || !sameDirectory(record.payload?.cwd, projectPath)) break;
          if (!/^[a-f\d-]{36}$/i.test(record.payload.id || '')) break;
          meta = record.payload;
        } else state = advanceTaskState(state, record);
      }
      if (meta) return { id: meta.id, state, modifiedAt: file.modifiedAt };
    } catch { }
  }
  return null;
}

function resumeCommand(info, allowFresh) {
  if (!info) return allowFresh ? 'codex resume --last\r' : null;
  if (!/^[a-f\d-]{36}$/i.test(info.id)) throw new Error('无效的 Codex 会话。');
  return `codex resume ${info.id}${info.state === 'interrupted' ? ' "继续"' : ''}\r`;
}

module.exports = { recentSession, advanceTaskState, resumeCommand, records, sameDirectory };
