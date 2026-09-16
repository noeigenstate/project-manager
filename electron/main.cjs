const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, Notification, clipboard, shell, protocol, net: electronNet } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const pty = require('node-pty');
const { WorkspaceStore } = require('./state.cjs');
const { createEventServer } = require('./events.cjs');
const { listDirectory, readProjectFile, resolveProjectPath, VIDEO_TYPES } = require('./project-files.cjs');
const { isTerminalResponse, acceptShellEvent, SubmissionTracker } = require('./terminal-input.cjs');
const { createTerminalEnvironment } = require('./terminal-env.cjs');
const { PreviewResources, resourceResponse } = require('./preview-resources.cjs');
const { resolveTerminalLink } = require('./terminal-links.cjs');
const { UpdateManager, isInstalledBuild } = require('./updates.cjs');
const { getSSHInfo } = require('./ssh-config.cjs');
const { SSHAuthServer } = require('./ssh-auth.cjs');
const { RemoteConnection } = require('./remote-connection.cjs');
const { recentSession, resumeCommand } = require('./session-restore.cjs');
const { CodexActivityReader, monitorActivity } = require('./codex-activity.cjs');
const { FileOperations } = require('./file-operations.cjs');
const { VoiceManager } = require('./voice.cjs');
const { windowsAppId, materializeIcon, repairShortcuts, refreshSearchIcons } = require('./windows-integration.cjs');

const root = path.join(__dirname, '..');
const integrationDir = app.isPackaged ? path.join(process.resourcesPath, 'integration') : path.join(root, 'integration');
const devUrl = !app.isPackaged ? process.env.PROJECT_GRID_DEV_URL : null;
if (process.env.PROJECT_GRID_DATA_DIR) app.setPath('userData', path.resolve(process.env.PROJECT_GRID_DATA_DIR));
app.setName('Project Grid');
const installed = isInstalledBuild(app.isPackaged, process.execPath);
const appUserModelId = windowsAppId({ packaged: app.isPackaged, installed, profile: process.env.PROJECT_GRID_DATA_DIR });
app.setAppUserModelId(appUserModelId);
protocol.registerSchemesAsPrivileged([
  { scheme: 'project-grid', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'project-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let window, tray, store, eventServer, sshAuth, updateManager, quitting = false, installingUpdate = false;
const sessions = new Map();
const branches = new Map();
const startupErrors = new Map();
const restorePlans = new Map();
const previewResources = new PreviewResources({ remote: project => remoteFor(project.id) });
let stateTimer;
let runtimeDir;
let sshAskpassPath;
let sshAskpassDir;
let activeTerminal = null;
let activeFileTree = null;
let fileOperations, fileProgress = null;
let voiceManager;
let attentionTimer;
const powershellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function send(channel, data) { if (window && !window.isDestroyed()) window.webContents.send(channel, data); }
function findProject(id) {
  if (typeof id !== 'string') throw new Error('无效的项目。');
  const project = store.projects.find(p => p.id === id);
  if (!project) throw new Error('项目不存在。');
  return project;
}
function publicState() {
  return {
    projects: store.projects.map(p => {
      const s = sessions.get(p.id);
      return {
        id: p.id, name: p.name, path: p.path, unread: p.unread, done: p.done, lastCompletedAt: p.lastCompletedAt, awaitingCompletion: p.completionArmed,
        kind: p.kind || 'local', ssh: p.ssh || null,
        branch: branches.get(p.id) || '',
        sessionId: s?.sessionId || null,
        status: s ? s.status : 'stopped',
        codexActive: s?.codexActive || false,
        codexActivity: s?.codexActivity || 'unknown',
        shellReady: !!s?.ready && !s?.inputDirty,
        codexAvailable: s?.codexAvailable ?? null,
        lastActivityAt: s?.lastActivityAt || null,
        error: s?.error || startupErrors.get(p.id) || null,
      };
    }),
    settings: store.settings,
    warning: store.warning,
    platform: process.platform,
    version: app.getVersion(),
  };
}
function updateIndicators() {
  const unread = store.projects.filter(p => p.unread > 0).length;
  if (window && !window.isDestroyed()) {
    window.setTitle(`${unread ? `(${unread}) ` : ''}Project Grid · 项目矩阵`);
    if (!unread) window.flashFrame(false);
  }
  if (tray && !tray.isDestroyed()) {
    tray.setImage(nativeImage.createFromPath(path.join(root, 'assets', unread ? 'icon-alert.png' : 'icon.png')));
    tray.setToolTip(unread ? `Project Grid · ${unread} 个项目待查看` : 'Project Grid · 项目矩阵');
  }
}
function broadcast() {
  clearTimeout(stateTimer);
  stateTimer = null;
  updateIndicators();
  send('workspace:changed', publicState());
}
function scheduleState() { if (!stateTimer) stateTimer = setTimeout(() => { stateTimer = null; broadcast(); }, 700); }
function report(error) { send('app:error', String(error?.message || error)); }

function showWindow(id) {
  if (!window || window.isDestroyed()) return;
  window.show();
  if (window.isMinimized()) window.restore();
  window.focus();
  if (id) send('project:focus', id);
}

function notifyCompletion(project) {
  if (!window.isFocused()) {
    window.flashFrame(true); clearTimeout(attentionTimer);
    attentionTimer = setTimeout(() => { if (window && !window.isDestroyed()) window.flashFrame(false); }, 9000);
    attentionTimer.unref?.();
  }
  if (store.settings.notifications && Notification.isSupported()) {
    const note = new Notification({
      title: `${project.name} · Codex 已完成`,
      body: '这一轮任务已结束，点击查看终端。',
      icon: path.join(root, 'assets/icon-alert.png'),
      silent: !store.settings.sound,
    });
    note.on('click', () => showWindow(project.id));
    note.on('failed', () => {});
    note.show();
  }
}

function onEvent(event) {
  const s = sessions.get(event.projectId);
  if (!s || event.sessionKey !== s.sessionKey) return;
  const project = store.projects.find(p => p.id === event.projectId);
  if (!project) return;
  if (event.type !== 'turn-complete' && !acceptShellEvent(s, event)) return;
  if (event.type === 'shell-ready' || event.type === 'shell-prompt') {
    s.activityMonitor?.stop(); s.activityMonitor = null;
    s.codexActive = false; s.codexActivity = 'unknown';
    s.ready = event.type === 'shell-prompt';
    s.inputDirty = false;
    s.status = 'shell';
    s.codexAvailable = event.codexAvailable === true;
    if (typeof event.codexHome === 'string') s.codexHome = event.codexHome;
    if (!quitting && typeof event.cwd === 'string') store.setRestore(project.id, { cwd: event.cwd });
  } else if (event.type === 'codex-started') {
    s.ready = false;
    s.codexActive = true;
    s.status = 'codex';
    s.error = null;
    s.submissions.reset();
    s.codexActivity = 'unknown'; s.activitySince = Date.now(); s.activityInputAt = 0;
    const remoteSince = Number.isFinite(event.sentAt) ? event.sentAt : s.activitySince;
    s.activityMonitor?.stop();
    const reader = project.kind === 'ssh' ? null : new CodexActivityReader(event.cwd || project.path, event.codexHome || s.codexHome, s.activitySince);
    s.activityMonitor = monitorActivity(
      () => reader ? reader.read() : s.terminal.request('codex-status', { since: remoteSince }),
      snapshot => {
        if (sessions.get(project.id) !== s || !s.codexActive) return;
        if (!reader) snapshot = { ...snapshot, updatedAt: snapshot.updatedAt + s.activitySince - remoteSince };
        // Resumed history and a slow response from before a new submission
        // must not make newly running work look complete.
        if (snapshot.updatedAt < Math.max(s.activitySince, s.activityInputAt)) return;
        s.rootThreadId = snapshot.threadId; s.activeTurnId = snapshot.turnId;
        s.codexActivity = snapshot.state;
        if (snapshot.state === 'working') store.expectCompletion(project.id);
        else if (snapshot.state === 'complete' && snapshot.turnId) {
          if (!project.done && !project.seenEvents.includes(`${snapshot.threadId}:${snapshot.turnId}`)) store.expectCompletion(project.id);
          if (store.complete(project.id, `${snapshot.threadId}:${snapshot.turnId}`, snapshot.updatedAt)) notifyCompletion(project);
        } else if (snapshot.state === 'interrupted') store.expectCompletion(project.id, false);
        broadcast();
      },
    );
    store.setRestore(project.id, { terminal: true, codex: true, cwd: event.cwd });
    // Unread completion is independent of session activity. It survives new turns.
  } else if (event.type === 'codex-exited') {
    s.activityMonitor?.stop(); s.activityMonitor = null; s.codexActivity = 'unknown';
    s.ready = false;
    s.codexActive = false;
    s.status = 'shell';
    if (!quitting) store.setRestore(project.id, { codex: false });
    const code = Number(event.exitCode);
    if (code && code !== 130 && code !== -1073741510) s.error = `Codex 已退出（代码 ${code}），请查看终端输出。`;
  } else if (event.type === 'turn-complete') {
    // notify is inherited by child agents. It only requests a refresh; the
    // interactive parent's task lifecycle is the authority for completion.
    if (s.codexActive && (!s.rootThreadId || event.threadId === s.rootThreadId)) void s.activityMonitor?.poll();
    return;
  } else return;
  broadcast();
  if (event.type === 'shell-prompt') void resumeAfterPrompt(project, s);
}

async function resumeAfterPrompt(project, session) {
  const plan = restorePlans.get(project.id);
  if (!plan || !session.ready || session.inputDirty) return;
  restorePlans.delete(project.id);
  if (!session.codexAvailable) return;
  try {
    const info = project.kind === 'ssh' ? await session.terminal.request('resume-info') : await recentSession(project.restore?.cwd || project.path, session.codexHome);
    // Legacy versions did not record which process owned a conversation. Open
    // that history, but do not submit work to a possibly still-running session.
    const command = resumeCommand(info && !plan.codex ? { ...info, state: 'unknown' } : info, plan.codex);
    if (command && sessions.get(project.id) === session && session.ready && !session.inputDirty && !session.codexActive) {
      // Opening completed history is not new input. Only the automatic
      // continuation of interrupted work may produce another completion alert.
      store.expectCompletion(project.id, info?.state === 'interrupted' && plan.codex);
      session.ready = false;
      session.terminal.write(command);
      broadcast();
    }
  } catch (error) { session.error = `恢复会话失败：${error.message}`; broadcast(); }
}

function remoteFor(id) {
  const project = findProject(id);
  const session = sessions.get(id);
  if (project.kind !== 'ssh' || !session || session.terminal.closed) throw new Error('请先启动终端，连接 SSH 服务器。');
  return session.terminal;
}

function captureBranch(project) {
  if (project.kind === 'ssh') return;
  execFile('git', ['-C', project.path, 'branch', '--show-current'], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
    if (!error && store.projects.some(p => p.id === project.id)) { branches.set(project.id, stdout.trim()); broadcast(); }
  });
}

function startTerminal(id) {
  const project = findProject(id);
  const old = sessions.get(id);
  if (old && old.status !== 'exited') return;
  if (old) disposeTerminal(id);
  if (process.platform !== 'win32') throw new Error('此版本的终端集成面向 Windows 10/11。');
  if (project.kind !== 'ssh' && !fs.existsSync(project.path)) throw new Error('项目目录不存在，请重新添加。');
  const sessionId = randomUUID();
  const sessionKey = randomUUID();
  const startPath = restorePlans.get(id)?.cwd || project.path;
  const bootstrapFile = project.kind === 'ssh' ? null : path.join(runtimeDir, `${sessionId}.json`);
  if (bootstrapFile) fs.writeFileSync(bootstrapFile, JSON.stringify({
    projectId: id, projectPath: startPath, sessionKey, pipeName: eventServer.name,
    powershellPath, notifyPath: path.join(integrationDir, 'notify.ps1'),
  }), { mode: 0o600 });
  const env = createTerminalEnvironment(process.env, bootstrapFile || '');
  if (project.kind === 'ssh' && !sshAskpassPath) {
    // Windows OpenSSH 8.1 cannot spawn an askpass executable under a Unicode
    // directory. The system temp volume provides an ASCII/short-path location
    // even when the workspace volume has 8.3 names disabled.
    sshAskpassDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'project-grid-ssh-'));
    const helper = path.join(sshAskpassDir, 'ssh-askpass.exe');
    fs.copyFileSync(path.join(integrationDir, 'ssh-askpass.exe'), helper);
    try { sshAskpassPath = execFileSync(helper, ['--short-path', helper], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim(); }
    catch { sshAskpassPath = helper; }
  }
  const terminal = project.kind === 'ssh' ? new RemoteConnection(project, { integrationDir, auth: sshAuth, sessionKey, onEvent, codingPath: startPath, askpassPath: sshAskpassPath,
    onReady: info => { branches.set(id, String(info.branch || '').slice(0, 120)); broadcast(); },
  }) : pty.spawn(powershellPath, ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', path.join(integrationDir, 'bootstrap.ps1')], {
    name: 'xterm-256color', cols: 90, rows: 22, cwd: startPath, env, useConpty: true, useConptyDll: true,
  });
  const s = {
    terminal, sessionId, sessionKey, bootstrapFile, status: 'starting', ready: false,
    codexActive: false, codexAvailable: null, seq: 0, chunks: [], bytes: 0, pending: '',
    flushTimer: null, lastActivityAt: Date.now(), error: null, submissions: new SubmissionTracker(),
  };
  sessions.set(id, s);
  store.setRestore(id, { terminal: true, ...(restorePlans.has(id) ? {} : { codex: false }) });
  startupErrors.delete(id);
  const flush = () => {
    clearTimeout(s.flushTimer); s.flushTimer = null;
    if (!s.pending) return;
    send('terminal:data', { id, sessionId, seq: ++s.seq, data: s.pending });
    s.pending = '';
  };
  s.flush = flush;
  terminal.onData(data => {
    if (sessions.get(id) !== s) return;
    s.chunks.push(data); s.bytes += data.length; s.pending += data;
    while (s.bytes > 1024 * 1024 && s.chunks.length > 1) s.bytes -= s.chunks.shift().length;
    s.lastActivityAt = Date.now();
    if (s.pending.length > 65536) flush();
    else if (!s.flushTimer) s.flushTimer = setTimeout(flush, 16);
  });
  terminal.onExit(({ exitCode }) => {
    if (sessions.get(id) !== s) return;
    flush();
    s.status = 'exited'; s.ready = false; s.codexActive = false;
    s.activityMonitor?.stop(); s.activityMonitor = null; s.codexActivity = 'unknown';
    restorePlans.delete(id);
    if (exitCode) s.error = terminal.error || `终端已退出（代码 ${exitCode}）。`;
    if (!quitting && !exitCode) store.setRestore(id, { terminal: false, codex: false });
    if (bootstrapFile) fs.rmSync(bootstrapFile, { force: true });
    broadcast();
  });
  captureBranch(project);
  broadcast();
}

function disposeTerminal(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  clearTimeout(s.flushTimer);
  s.activityMonitor?.stop();
  try { s.terminal.kill(); } catch { }
  if (s.bootstrapFile) fs.rmSync(s.bootstrapFile, { force: true });
}

function checkSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Rejected IPC sender');
  const url = event.senderFrame.url;
  if (!(devUrl ? url.startsWith(`${devUrl}/`) : url.startsWith('project-grid://app/'))) throw new Error('Rejected IPC origin');
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    checkSender(event);
    try { return { ok: true, value: await fn(...args) }; }
    catch (error) { return { ok: false, error: String(error?.message || error) }; }
  });
}
function listen(channel, fn) {
  ipcMain.on(channel, (event, ...args) => { try { checkSender(event); fn(...args); } catch (error) { report(error); } });
}

async function confirmTerminalClose(id, verb) {
  const project = findProject(id);
  const session = sessions.get(id);
  if (!session || session.status === 'exited') return true;
  const result = await dialog.showMessageBox(window, {
    type: 'question', title: `${verb}项目`, message: `${verb}“${project.name}”的终端？`,
    detail: '此终端内的 Codex 和其他运行中的命令会被结束。项目文件会保留。',
    buttons: ['取消', `确认${verb}`], defaultId: 0, cancelId: 0,
  });
  return result.response === 1;
}

async function requestQuit() {
  const count = [...sessions.values()].filter(s => s.status !== 'exited').length;
  if (count) {
    const result = await dialog.showMessageBox(window, {
      type: 'question', message: `退出并关闭 ${count} 个终端？`,
      detail: '运行中的任务会被结束。若要让任务继续，请最小化窗口或关闭到系统托盘。',
      buttons: ['继续运行', '退出应用'], defaultId: 0, cancelId: 0,
    });
    if (result.response !== 1) return false;
  }
  quitting = true;
  app.quit();
  return true;
}

function registerIpc() {
  handle('ssh:info', () => getSSHInfo());
  handle('ssh:auth-pending', () => sshAuth.getPending());
  handle('ssh:auth-answer', (id, answer) => sshAuth.answer(id, answer));
  handle('workspace:add-ssh', input => {
    const configuration = getSSHInfo();
    const { project, added } = store.addSSH({ ...input, configFile: configuration.configExists ? configuration.configFile : null });
    if (added || !sessions.has(project.id) || sessions.get(project.id).status === 'exited') {
      try { startTerminal(project.id); } catch (error) { startupErrors.set(project.id, error.message); }
    }
    broadcast(); return project.id;
  });
  handle('updates:state', () => updateManager.getState());
  handle('updates:check', () => updateManager.check());
  handle('updates:download-page', () => shell.openExternal('https://github.com/noeigenstate/project-manager/releases/latest'));
  handle('updates:install', async () => {
    if (installingUpdate) return false;
    if (!updateManager.canInstall()) throw new Error('更新尚未下载完成。');
    installingUpdate = true;
    try {
      const count = [...sessions.values()].filter(session => session.status !== 'exited').length;
      if (count) {
        const result = await dialog.showMessageBox(window, {
          type: 'question', title: '重启并安装更新', message: `重启会关闭 ${count} 个终端`,
          detail: '请先确认任务已经完成。取消后，下载好的更新会继续保留。',
          buttons: ['继续工作', '关闭终端并更新'], defaultId: 0, cancelId: 0,
        });
        if (result.response !== 1) { installingUpdate = false; return false; }
      }
      quitting = true;
      updateManager.install();
      return true;
    } catch (error) { quitting = false; installingUpdate = false; throw error; }
  });
  handle('workspace:state', publicState);
  handle('workspace:add', async () => {
    const result = await dialog.showOpenDialog(window, { title: '添加项目文件夹（可多选）', properties: ['openDirectory', 'multiSelections'] });
    if (result.canceled) return [];
    const ids = [];
    for (const folder of result.filePaths) {
      const { project, added } = store.add(folder);
      ids.push(project.id);
      if (added) {
        try { startTerminal(project.id); }
        catch (error) { startupErrors.set(project.id, error.message); }
      }
    }
    broadcast();
    return ids;
  });
  handle('workspace:remove', async id => {
    if (!await confirmTerminalClose(id, '移除')) return false;
    restorePlans.delete(id); disposeTerminal(id); previewResources.closeProject(id); store.remove(id); branches.delete(id); startupErrors.delete(id); broadcast(); return true;
  });
  handle('workspace:acknowledge', id => { findProject(id); store.acknowledge(id); broadcast(); });
  handle('workspace:swap', (source, target) => { findProject(source); findProject(target); store.swapProjects(source, target); broadcast(); });
  handle('workspace:reorder', ids => { store.reorderProjects(ids); broadcast(); });
  handle('workspace:done', (id, done) => { findProject(id); store.markDone(id, done); broadcast(); });
  handle('workspace:acknowledge-all', () => { for (const p of store.projects) p.unread = 0; store.save(); broadcast(); });
  handle('workspace:settings', patch => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('无效的设置。');
    store.updateSettings(patch); broadcast();
    if (patch.restoreSessions === false) restorePlans.clear();
  });
  handle('project:directory', (id, relativePath = '', offset = 0) => findProject(id).kind === 'ssh' ? remoteFor(id).request('directory', { path: relativePath, offset }) : listDirectory(findProject(id), relativePath, offset));
  handle('project:create-entry', (id, directory, name, kind) => fileOperations.create(findProject(id), directory, name, kind));
  handle('project:rename-entry', (id, relative, name) => fileOperations.rename(findProject(id), relative, name));
  handle('project:delete-entries', (id, paths) => fileOperations.remove(findProject(id), paths));
  handle('project:copy-entries', (id, paths) => fileOperations.copy(findProject(id), paths));
  handle('project:paste-entries', (id, directory) => fileOperations.paste(findProject(id), directory));
  handle('files:progress', () => fileProgress);
  handle('files:cancel', () => fileOperations.cancel());
  handle('voice:state', () => voiceManager.getState());
  handle('voice:prepare', () => voiceManager.prepare());
  handle('voice:cancel', mode => { if (!['download', 'recognition'].includes(mode)) throw new Error('无效的语音操作。'); voiceManager.cancel(mode); });
  handle('voice:transcribe', (audio, language) => voiceManager.transcribe(audio, language));
  listen('files:focus', (id, focused) => { if (focused) { findProject(id); activeFileTree = id; activeTerminal = null; } else if (activeFileTree === id) activeFileTree = null; });
  handle('project:file', async (id, relativePath, pageIndex) => {
    const project = findProject(id);
    const preview = project.kind === 'ssh' ? await remoteFor(id).request('preview', { path: relativePath, page: pageIndex || 0 }) : await readProjectFile(project, relativePath, pageIndex);
    if (['image', 'html', 'video'].includes(preview.kind)) return { ...preview, ...previewResources.open(project, relativePath, preview.kind, preview.mimeType) };
    return preview;
  });
  handle('project:preview-close', id => previewResources.close(id));
  handle('project:open-link', async (id, target) => {
    const project = findProject(id);
    if (project.kind === 'ssh' && !/^(https?:\/\/|www\.)/i.test(target)) {
      const remote = remoteFor(id); await remote.ready;
      let value = String(target);
      if (/^file:\/\//i.test(value)) value = decodeURIComponent(new URL(value).pathname);
      else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/:[0-9]+(?::[0-9]+)?$/.test(value)) throw new Error('只支持网页链接和远程项目内文件。');
      for (const candidate of new Set([value, value.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/, '')])) {
        const relative = path.posix.relative(remote.info.root, path.posix.resolve(remote.info.root, candidate));
        if (relative === '..' || relative.startsWith('../')) throw new Error('该链接指向远程项目目录之外。');
        try {
          const stat = await remote.request('stat', { path: relative });
          if (stat.directory) { await openInCode(id, relative); return { kind: 'external' }; }
          return { kind: 'file', path: relative };
        } catch (error) { if (candidate === value.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/, '')) throw error; }
      }
    }
    const link = await resolveTerminalLink(findProject(id), target);
    if (link.kind === 'external') { await shell.openExternal(link.url); return { kind: 'external' }; }
    if (link.kind === 'directory') { const error = await shell.openPath(link.path); if (error) throw new Error(error); return { kind: 'external' }; }
    return link;
  });
  handle('project:open-video', async (id, relativePath) => {
    if (findProject(id).kind === 'ssh') throw new Error('远程视频请使用内置播放器，或先下载到本机再用系统播放器打开。');
    const resolved = await resolveProjectPath(findProject(id), relativePath);
    if (!VIDEO_TYPES[path.extname(resolved).toLowerCase()] || !(await fs.promises.stat(resolved)).isFile()) throw new Error('请选择一个视频文件。');
    const error = await shell.openPath(resolved); if (error) throw new Error(error);
  });
  handle('project:reveal', async id => { if (findProject(id).kind === 'ssh') return openInCode(id); const error = await shell.openPath(findProject(id).path); if (error) throw new Error(error); });
  const openInCode = async (id, relativePath) => {
    const project = findProject(id);
    let target;
    if (project.kind === 'ssh') {
      const remoteRoot = sessions.get(id)?.terminal.info?.root || project.path;
      if (!remoteRoot.startsWith('/')) throw new Error('请先连接 SSH，解析远程主目录。');
      target = path.posix.resolve(remoteRoot, relativePath || '.');
      const relative = path.posix.relative(remoteRoot, target);
      if (relative === '..' || relative.startsWith('../')) throw new Error('文件不在项目目录内。');
    } else target = relativePath ? await resolveProjectPath(project, relativePath) : project.path;
    const found = await new Promise(resolve => execFile('where.exe', ['code'], { windowsHide: true, timeout: 3000 }, (err, output) => resolve(err ? [] : output.trim().split(/\r?\n/))));
    const candidates = found.map(filename => path.join(path.dirname(path.dirname(filename)), 'Code.exe'));
    candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'));
    const executable = candidates.find(p => fs.existsSync(p));
    if (!executable) throw new Error('没有找到 VS Code。请将 VS Code 的 code 命令加入 PATH。');
    const child = spawn(executable, project.kind === 'ssh' ? ['--remote', `ssh-remote+${project.ssh.host}`, target] : [target], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', report); child.unref();
  };
  handle('project:code', openInCode);
  handle('terminal:start', startTerminal);
  handle('terminal:restart', async id => {
    if (!await confirmTerminalClose(id, '重启')) return false;
    restorePlans.delete(id);
    disposeTerminal(id); startTerminal(id); return true;
  });
  handle('terminal:attach', id => {
    findProject(id);
    const s = sessions.get(id);
    if (!s) return { sessionId: null, seq: 0, data: '' };
    s.flush();
    return { sessionId: s.sessionId, seq: s.seq, data: s.chunks.join('') };
  });
  handle('terminal:codex', id => {
    findProject(id);
    const s = sessions.get(id);
    if (!s?.ready || s.inputDirty) throw new Error('请先结束当前命令，并在空白终端提示符下启动 Codex。');
    if (s.codexActive) return;
    if (!s.codexAvailable) throw new Error('终端中未找到 Codex CLI，请安装后重启终端。');
    store.markDone(id, false);
    s.codexActive = true; s.status = 'codex';
    s.ready = false; s.terminal.write('codex\r'); broadcast();
  });
  listen('terminal:write', (id, data) => {
    if (typeof data !== 'string' || data.length > 1024 * 1024) return;
    const s = sessions.get(id);
    if (s && s.status !== 'exited') {
      if (s.submissions.write(data) && s.codexActive) {
        store.expectCompletion(id);
        s.codexActivity = 'working'; s.activityInputAt = Date.now();
        scheduleState();
      }
      if (!s.codexActive && !isTerminalResponse(data)) {
        const wasReady = s.ready && !s.inputDirty;
        s.inputDirty = true; if (data.includes('\r') || data.includes('\n')) s.ready = false;
        if (wasReady) scheduleState();
      }
      s.terminal.write(data);
    }
  });
  listen('terminal:resize', (id, cols, rows) => {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 250) return;
    const s = sessions.get(id);
    if (s && s.status !== 'exited') s.terminal.resize(cols, rows);
  });
  handle('clipboard:copy', text => { if (typeof text !== 'string') throw new Error('无效的剪贴板内容。'); return clipboard.writeText(text); });
  handle('clipboard:read', () => clipboard.readText());
  handle('terminal:paste', (id, text, sessionId) => {
    const session = sessions.get(id);
    if (!session || session.sessionId !== sessionId || ['starting', 'exited'].includes(session.status)) throw new Error('终端已变化或尚未就绪，请复制文字后手动粘贴。');
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('无效的文字。');
    send('terminal:paste', { id, sessionId, text });
  });
  listen('terminal:focus', (id, focused) => { if (sessions.has(id) && focused) { activeTerminal = id; activeFileTree = null; } else if (activeTerminal === id) activeTerminal = null; });
  listen('window:minimize', () => window.minimize());
  listen('window:maximize', () => window.isMaximized() ? window.unmaximize() : window.maximize());
  listen('window:close', () => window.close());
  listen('window:focus-mode', enabled => { if (typeof enabled === 'boolean') window.setFullScreen(enabled); });
  handle('app:quit', requestQuit);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(async () => {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    let shellIcon = path.join(root, 'assets/icon.ico');
    if (process.platform === 'win32') shellIcon = materializeIcon(shellIcon, app.getPath('userData'));
    if (process.platform === 'win32' && installed && !process.env.PROJECT_GRID_DATA_DIR) {
      try {
        const repaired = repairShortcuts({ shell, executable: process.execPath, iconSource: shellIcon, userData: app.getPath('userData'),
          programs: path.join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs'),
          commonPrograms: process.env.ProgramData ? path.join(process.env.ProgramData, 'Microsoft/Windows/Start Menu/Programs') : null,
          desktop: app.getPath('desktop'), commonDesktop: process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : null,
        });
        shellIcon = repaired.icon;
        if (repaired.changes.length) execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/ie4uinit.exe'), ['-show'], { windowsHide: true, timeout: 5000 }, () => {});
      } catch (error) { console.warn('Windows shortcut repair:', error.message); }
    }
    if (process.platform === 'win32' && app.isPackaged && !process.env.PROJECT_GRID_DATA_DIR) {
      try {
        const refreshed = refreshSearchIcons({ localAppData: process.env.LOCALAPPDATA, userData: app.getPath('userData'), iconSource: shellIcon });
        if (refreshed.changes.length) execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/ie4uinit.exe'), ['-show'], { windowsHide: true, timeout: 5000 }, () => {});
      } catch (error) { console.warn('Windows Search icon refresh:', error.message); }
    }
    store = new WorkspaceStore(path.join(app.getPath('userData'), 'workspace.json'));
    voiceManager = new VoiceManager({ directory: path.join(app.getPath('userData'), 'voice'), fetcher: (url, options) => electronNet.fetch(url, options), changed: state => send('voice:state', state) });
    fileOperations = new FileOperations({ integrationDir, cacheRoot: path.join(app.getPath('userData'), 'file-clipboard'), remote: remoteFor,
      trash: filename => shell.trashItem(filename),
      confirmDelete: async (project, paths) => (await dialog.showMessageBox(window, { type: 'question', title: '删除文件', message: `删除 ${paths.length} 个文件或文件夹？`,
        detail: `${paths.slice(0, 5).join('\n')}${paths.length > 5 ? '\n…' : ''}\n\n${project.kind === 'ssh' ? '远程文件会被永久删除。' : '本地文件会移入回收站。'}`,
        buttons: ['取消', '删除'], defaultId: 0, cancelId: 0 })).response === 1,
      progress: value => { fileProgress = value; send('files:progress', value); },
    });
    runtimeDir = fs.mkdtempSync(path.join(app.getPath('userData'), 'runtime-'));
    eventServer = await createEventServer(onEvent);
    sshAuth = await new SSHAuthServer(queue => send('ssh:auth-changed', queue)).start();
    updateManager = new UpdateManager({
      updater: isInstalledBuild(app.isPackaged, process.execPath) ? require('electron-updater').autoUpdater : null,
      version: app.getVersion(), onChange: state => {
        if (state.status === 'error' && installingUpdate) { installingUpdate = false; quitting = false; }
        send('updates:changed', state);
      },
    });
    protocol.handle('project-grid', request => {
      const url = new URL(request.url);
      if (url.host !== 'app') return new Response('Not found', { status: 404 });
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const resolved = path.resolve(root, 'dist', relative);
      if (!resolved.startsWith(path.resolve(root, 'dist') + path.sep)) return new Response('Forbidden', { status: 403 });
      return electronNet.fetch(pathToFileURL(resolved).toString());
    });
    protocol.handle('project-preview', async request => {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      try {
        const resource = await previewResources.resolve(request.url);
        return resourceResponse(resource, request);
      } catch { return new Response('文件不存在、超出项目范围，或预览已关闭。', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }); }
    });
    registerIpc();
    window = new BrowserWindow({
      width: 1500, height: 940, minWidth: 820, minHeight: 560,
      title: 'Project Grid · 项目矩阵', backgroundColor: '#101216',
      frame: false, show: false, icon: path.join(root, 'assets/icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false },
    });
    if (process.platform === 'win32') window.setAppDetails({ appId: appUserModelId, appIconPath: shellIcon, appIconIndex: 0,
      relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${root}"`,
      relaunchDisplayName: process.env.PROJECT_GRID_DATA_DIR ? 'Project Grid Test' : !app.isPackaged ? 'Project Grid Dev' : installed ? 'Project Grid' : 'Project Grid Portable',
    });
    // Native fullscreen can temporarily mark a visible window as occluded.
    // Keep its live terminals and zoom painting; throttle only after hiding it.
    window.on('hide', () => window.webContents.setBackgroundThrottling(true));
    window.on('minimize', () => window.webContents.setBackgroundThrottling(true));
    window.on('show', () => window.webContents.setBackgroundThrottling(false));
    window.on('restore', () => window.webContents.setBackgroundThrottling(false));
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('context-menu', (_event, params) => {
      if (activeTerminal || (!params.isEditable && !params.selectionText)) return;
      const items = params.isEditable ? [
        { label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' }, { type: 'separator' },
        { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' }, { label: '粘贴', role: 'paste' }, { type: 'separator' }, { label: '全选', role: 'selectAll' },
      ] : [{ label: '复制', role: 'copy' }];
      Menu.buildFromTemplate(items).popup({ window });
    });
    // A frameless window has no Edit menu accelerators. Explicitly retain
    // standard editing shortcuts for inputs, including SSH password fields.
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || activeTerminal || input.alt) return;
      const key = input.key.toLowerCase();
      if (activeFileTree && (((input.control || input.meta) && ['a', 'c', 'v'].includes(key)) || ['delete', 'f2'].includes(key) || (key === 'insert' && (input.control || input.shift)))) return;
      let action;
      if (input.control || input.meta) action = { c: 'copy', x: 'cut', v: input.shift ? 'pasteAndMatchStyle' : 'paste', a: 'selectAll', z: input.shift ? 'redo' : 'undo', y: 'redo', insert: 'copy' }[key];
      else if (input.shift && key === 'insert') action = 'paste';
      if (action) { event.preventDefault(); window.webContents[action](); }
    });
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-frame-navigate', event => {
      if (!event.isMainFrame && event.url !== 'about:blank' && !previewResources.hasUrl(event.url)) event.preventDefault();
    });
    const allowPlayerFullscreen = (contents, permission, details) => permission === 'fullscreen' && contents === window.webContents && details.isMainFrame === true;
    const isAppFrame = (contents, details) => contents === window.webContents && details.isMainFrame === true && (devUrl ? contents.getURL().startsWith(devUrl + '/') : contents.getURL().startsWith('project-grid://app/'));
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowPlayerFullscreen(contents, permission, details) || permission === 'media' && isAppFrame(contents, details) && details.mediaTypes?.length > 0 && details.mediaTypes.every(type => type === 'audio')));
    window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => allowPlayerFullscreen(contents, permission, details) || permission === 'media' && isAppFrame(contents, details) && details.mediaType === 'audio');
    window.once('ready-to-show', () => window.show());
    window.on('focus', () => { clearTimeout(attentionTimer); window.flashFrame(false); });
    window.webContents.on('render-process-gone', (_event, details) => {
      if (!quitting && details.reason !== 'clean-exit') window.reload();
    });
    window.on('close', event => {
      if (quitting) return;
      event.preventDefault();
      if (store.settings.closeToTray && tray) window.hide();
      else requestQuit().catch(report);
    });
    tray = new Tray(nativeImage.createFromPath(path.join(root, 'assets/icon.png')));
    tray.setToolTip('Project Grid · 项目矩阵');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开项目矩阵', click: () => showWindow() },
      { type: 'separator' },
      { label: '退出应用', click: () => { showWindow(); requestQuit().catch(report); } },
    ]));
    tray.on('click', () => showWindow());
    Menu.setApplicationMenu(null);
    for (const project of store.projects) captureBranch(project);
    await window.loadURL(devUrl || 'project-grid://app/index.html');
    updateIndicators();
    if (!process.env.PROJECT_GRID_DATA_DIR) updateManager.start();
    if (store.settings.restoreSessions && (!process.env.PROJECT_GRID_DATA_DIR || process.env.PROJECT_GRID_TEST_RESTORE === '1')) {
      const projects = store.projects.filter(project => !project.done && (project.restore === null || project.restore.terminal));
      projects.forEach((project, index) => {
        if (project.restore === null || project.restore.codex) restorePlans.set(project.id, { codex: project.restore?.codex === true, cwd: project.restore?.cwd });
        const timer = setTimeout(() => {
          if (quitting || !store.settings.restoreSessions || !store.projects.some(item => item.id === project.id)) return;
          try { startTerminal(project.id); } catch (error) { restorePlans.delete(project.id); startupErrors.set(project.id, error.message); broadcast(); }
        }, index * 300);
        timer.unref?.();
      });
    }
  }).catch(error => {
    dialog.showErrorBox('Project Grid 无法启动', String(error?.stack || error));
    app.exit(1);
  });
}
app.on('before-quit', () => {
  clearTimeout(attentionTimer);
  voiceManager?.close(); fileOperations?.cancel();
  quitting = true;
  updateManager?.dispose();
  clearTimeout(stateTimer);
  for (const id of sessions.keys()) disposeTerminal(id);
  sshAuth?.close();
  eventServer?.close();
  tray?.destroy();
  if (sshAskpassDir) {
    try { fs.rmSync(path.join(sshAskpassDir, 'ssh-askpass.exe'), { force: true }); fs.rmdirSync(sshAskpassDir); } catch { }
  }
  if (runtimeDir) {
    // Only this launch's generated, now-empty runtime directory is removed.
    try { fs.rmdirSync(runtimeDir); } catch { }
  }
});
app.on('window-all-closed', () => { if (quitting) app.quit(); });
