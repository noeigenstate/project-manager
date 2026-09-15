const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { normalizeSSH } = require('./ssh-config.cjs');

const defaults = { columns: 0, notifications: true, sound: true, closeToTray: true, explorerCollapsed: false, fontSize: 12, restoreSessions: true };

function cleanSettings(input = {}) {
  return {
    columns: [0, 1, 2, 3, 4].includes(input.columns) ? input.columns : defaults.columns,
    fontSize: Number.isInteger(input.fontSize) && input.fontSize >= 10 && input.fontSize <= 20 ? input.fontSize : defaults.fontSize,
    ...Object.fromEntries(['notifications', 'sound', 'closeToTray', 'explorerCollapsed', 'restoreSessions'].map(key => [key, typeof input[key] === 'boolean' ? input[key] : defaults[key]])),
  };
}

class WorkspaceStore {
  constructor(filename) {
    this.filename = filename;
    this.projects = [];
    this.settings = { ...defaults };
    this.warning = null;
    if (!fs.existsSync(filename)) return;
    try {
      const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (![1, 2].includes(value.version) || !Array.isArray(value.projects)) throw new Error('Unsupported workspace format');
      const ids = new Set();
      this.projects = value.projects.filter(p => {
        if (!p || typeof p.id !== 'string' || typeof p.path !== 'string' || ids.has(p.id)) return false;
        if (p.kind === 'ssh') { try { normalizeSSH({ ...p.ssh, path: p.path }); } catch { return false; } }
        else if (!path.isAbsolute(p.path)) return false;
        ids.add(p.id); return true;
      }).map(p => ({
        id: p.id, name: String(p.name || path.basename(p.path)).slice(0, 120), path: p.path,
        kind: p.kind === 'ssh' ? 'ssh' : 'local',
        ...(p.kind === 'ssh' ? { ssh: { host: p.ssh.host, configFile: p.ssh.configFile || null } } : {}),
        restore: p.restore && typeof p.restore === 'object' ? { terminal: p.restore.terminal === true, codex: p.restore.codex === true, cwd: typeof p.restore.cwd === 'string' && (p.kind === 'ssh' ? p.restore.cwd.startsWith('/') : path.isAbsolute(p.restore.cwd)) ? p.restore.cwd : null } : null,
        unread: Number.isSafeInteger(p.unread) && p.unread > 0 ? p.unread : 0,
        done: p.done === true,
        lastCompletedAt: typeof p.lastCompletedAt === 'number' ? p.lastCompletedAt : null,
        seenEvents: Array.isArray(p.seenEvents) ? p.seenEvents.filter(x => typeof x === 'string').slice(-128) : [],
      }));
      this.settings = cleanSettings(value.settings);
    } catch {
      const backup = `${filename}.unreadable-${Date.now()}`;
      fs.copyFileSync(filename, backup);
      this.warning = `工作区配置无法读取，原文件已保留在 ${backup}`;
    }
  }

  add(folder) {
    const canonical = fs.realpathSync(folder);
    if (!fs.statSync(canonical).isDirectory()) throw new Error('请选择项目文件夹。');
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    const existing = this.projects.find(p => p.kind !== 'ssh' && (process.platform === 'win32' ? p.path.toLowerCase() : p.path) === key);
    if (existing) return { project: existing, added: false };
    const project = { id: randomUUID(), name: path.basename(canonical) || canonical, path: canonical, kind: 'local', restore: { terminal: false, codex: false }, unread: 0, done: false, lastCompletedAt: null, seenEvents: [] };
    this.projects.push(project);
    this.save();
    return { project, added: true };
  }

  addSSH(input) {
    const connection = normalizeSSH(input);
    const existing = this.projects.find(p => p.kind === 'ssh' && p.ssh.host === connection.host && p.ssh.configFile === connection.configFile && p.path === connection.path);
    if (existing) return { project: existing, added: false };
    const base = path.posix.basename(connection.path);
    const project = { id: randomUUID(), name: String(input.name || (base === '~' ? connection.host : base) || connection.host).slice(0, 120), kind: 'ssh', path: connection.path, ssh: { host: connection.host, configFile: connection.configFile }, restore: { terminal: false, codex: false }, unread: 0, done: false, lastCompletedAt: null, seenEvents: [] };
    this.projects.push(project); this.save(); return { project, added: true };
  }

  setRestore(id, patch) {
    const project = this.projects.find(p => p.id === id);
    if (!project) return;
    const next = { terminal: project.restore?.terminal === true, codex: project.restore?.codex === true, cwd: project.restore?.cwd || null };
    if (typeof patch.terminal === 'boolean') next.terminal = patch.terminal;
    if (typeof patch.codex === 'boolean') next.codex = patch.codex;
    if (typeof patch.cwd === 'string' && patch.cwd.length <= 4096 && !/[\0\r\n]/.test(patch.cwd) && (project.kind === 'ssh' ? patch.cwd.startsWith('/') : path.isAbsolute(patch.cwd))) next.cwd = patch.cwd;
    if (JSON.stringify(next) === JSON.stringify(project.restore)) return;
    project.restore = next;
    this.save();
  }

  swapProjects(sourceId, targetId) {
    const source = this.projects.findIndex(project => project.id === sourceId);
    const target = this.projects.findIndex(project => project.id === targetId);
    if (source < 0 || target < 0) throw new Error('项目不存在，请刷新工作区后重试。');
    if (source === target) return;
    [this.projects[source], this.projects[target]] = [this.projects[target], this.projects[source]];
    this.save();
  }

  complete(id, eventId, now = Date.now()) {
    const project = this.projects.find(p => p.id === id);
    if (!project || typeof eventId !== 'string' || !eventId || eventId.length > 256 || project.seenEvents.includes(eventId)) return false;
    project.seenEvents = [...project.seenEvents, eventId].slice(-128);
    project.unread += 1;
    project.done = false;
    project.lastCompletedAt = now;
    this.save();
    return true;
  }

  acknowledge(id) {
    const project = this.projects.find(p => p.id === id);
    if (project) project.unread = 0;
    this.save();
  }

  markDone(id, done) {
    const project = this.projects.find(p => p.id === id);
    if (project) { project.done = done === true; if (project.done) project.unread = 0; }
    this.save();
  }

  remove(id) { this.projects = this.projects.filter(p => p.id !== id); this.save(); }
  updateSettings(patch) { this.settings = cleanSettings({ ...this.settings, ...patch }); this.save(); }
  save() {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const tmp = `${this.filename}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, projects: this.projects, settings: this.settings }, null, 2));
    fs.renameSync(tmp, this.filename);
  }
}

module.exports = { WorkspaceStore, cleanSettings };
