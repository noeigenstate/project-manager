const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const defaults = { columns: 0, notifications: true, sound: true, closeToTray: true, explorerCollapsed: false, fontSize: 12 };

function cleanSettings(input = {}) {
  return {
    columns: [0, 1, 2, 3, 4].includes(input.columns) ? input.columns : defaults.columns,
    fontSize: Number.isInteger(input.fontSize) && input.fontSize >= 10 && input.fontSize <= 20 ? input.fontSize : defaults.fontSize,
    ...Object.fromEntries(['notifications', 'sound', 'closeToTray', 'explorerCollapsed'].map(key => [key, typeof input[key] === 'boolean' ? input[key] : defaults[key]])),
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
      if (value.version !== 1 || !Array.isArray(value.projects)) throw new Error('Unsupported workspace format');
      const ids = new Set();
      this.projects = value.projects.filter(p => p && typeof p.id === 'string' && typeof p.path === 'string' && path.isAbsolute(p.path) && !ids.has(p.id) && ids.add(p.id)).map(p => ({
        id: p.id, name: String(p.name || path.basename(p.path)).slice(0, 120), path: p.path,
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
    const existing = this.projects.find(p => (process.platform === 'win32' ? p.path.toLowerCase() : p.path) === key);
    if (existing) return { project: existing, added: false };
    const project = { id: randomUUID(), name: path.basename(canonical) || canonical, path: canonical, unread: 0, done: false, lastCompletedAt: null, seenEvents: [] };
    this.projects.push(project);
    this.save();
    return { project, added: true };
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
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, projects: this.projects, settings: this.settings }, null, 2));
    fs.renameSync(tmp, this.filename);
  }
}

module.exports = { WorkspaceStore, cleanSettings };
