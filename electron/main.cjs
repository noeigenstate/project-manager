const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, Notification, clipboard, shell, protocol, net: electronNet } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const pty = require('node-pty');
const { WorkspaceStore } = require('./state.cjs');
const { createEventServer } = require('./events.cjs');
const { listDirectory, readProjectFile, resolveProjectPath } = require('./project-files.cjs');
const { isTerminalResponse, acceptShellEvent } = require('./terminal-input.cjs');

const root = path.join(__dirname, '..');
const integrationDir = app.isPackaged ? path.join(process.resourcesPath, 'integration') : path.join(root, 'integration');
const devUrl = !app.isPackaged ? process.env.PROJECT_GRID_DEV_URL : null;
if (process.env.PROJECT_GRID_DATA_DIR) app.setPath('userData', path.resolve(process.env.PROJECT_GRID_DATA_DIR));
app.setName('Project Grid');
app.setAppUserModelId('local.projectgrid.desktop');
protocol.registerSchemesAsPrivileged([{ scheme: 'project-grid', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let window, tray, store, eventServer, quitting = false;
const sessions = new Map();
const branches = new Map();
const startupErrors = new Map();
let stateTimer;
let runtimeDir;
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
        id: p.id, name: p.name, path: p.path, unread: p.unread, done: p.done, lastCompletedAt: p.lastCompletedAt,
        branch: branches.get(p.id) || '',
        sessionId: s?.sessionId || null,
        status: s ? s.status : 'stopped',
        codexActive: s?.codexActive || false,
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
  if (!window.isFocused()) window.flashFrame(true);
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
    s.ready = event.type === 'shell-prompt';
    s.inputDirty = false;
    s.status = 'shell';
    s.codexAvailable = event.codexAvailable === true;
  } else if (event.type === 'codex-started') {
    s.ready = false;
    s.codexActive = true;
    s.status = 'codex';
    s.error = null;
    // Unread completion is independent of session activity. It survives new turns.
  } else if (event.type === 'codex-exited') {
    s.ready = false;
    s.codexActive = false;
    s.status = 'shell';
    const code = Number(event.exitCode);
    if (code && code !== 130 && code !== -1073741510) s.error = `Codex 已退出（代码 ${code}），请查看终端输出。`;
  } else if (event.type === 'turn-complete') {
    if (store.complete(project.id, event.eventId)) notifyCompletion(project);
  } else return;
  broadcast();
}

function captureBranch(project) {
  execFile('git', ['-C', project.path, 'branch', '--show-current'], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
    if (!error && store.projects.some(p => p.id === project.id)) { branches.set(project.id, stdout.trim()); broadcast(); }
  });
}

function startTerminal(id) {
  const project = findProject(id);
  const old = sessions.get(id);
  if (old && old.status !== 'exited') return;
  if (process.platform !== 'win32') throw new Error('此版本的终端集成面向 Windows 10/11。');
  if (!fs.existsSync(project.path)) throw new Error('项目目录不存在，请重新添加。');
  const sessionId = randomUUID();
  const sessionKey = randomUUID();
  const bootstrapFile = path.join(runtimeDir, `${sessionId}.json`);
  fs.writeFileSync(bootstrapFile, JSON.stringify({
    projectId: id, projectPath: project.path, sessionKey, pipeName: eventServer.name,
    powershellPath, notifyPath: path.join(integrationDir, 'notify.ps1'),
  }), { mode: 0o600 });
  const env = { ...process.env, PROJECT_GRID_BOOTSTRAP: bootstrapFile, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PROJECT_GRID_DATA_DIR;
  delete env.PROJECT_GRID_DEV_URL;
  const terminal = pty.spawn(powershellPath, ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', path.join(integrationDir, 'bootstrap.ps1')], {
    name: 'xterm-256color', cols: 90, rows: 22, cwd: project.path, env, useConpty: true,
  });
  const s = {
    terminal, sessionId, sessionKey, bootstrapFile, status: 'starting', ready: false,
    codexActive: false, codexAvailable: null, seq: 0, chunks: [], bytes: 0, pending: '',
    flushTimer: null, lastActivityAt: Date.now(), error: null,
  };
  sessions.set(id, s);
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
    scheduleState();
  });
  terminal.onExit(({ exitCode }) => {
    if (sessions.get(id) !== s) return;
    flush();
    s.status = 'exited'; s.ready = false; s.codexActive = false;
    if (exitCode) s.error = `终端已退出（代码 ${exitCode}）。`;
    fs.rmSync(bootstrapFile, { force: true });
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
  try { s.terminal.kill(); } catch { }
  fs.rmSync(s.bootstrapFile, { force: true });
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
    disposeTerminal(id); store.remove(id); branches.delete(id); startupErrors.delete(id); broadcast(); return true;
  });
  handle('workspace:acknowledge', id => { findProject(id); store.acknowledge(id); broadcast(); });
  handle('workspace:done', (id, done) => { findProject(id); store.markDone(id, done); broadcast(); });
  handle('workspace:acknowledge-all', () => { for (const p of store.projects) p.unread = 0; store.save(); broadcast(); });
  handle('workspace:settings', patch => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('无效的设置。');
    store.updateSettings(patch); broadcast();
  });
  handle('project:directory', (id, relativePath, offset) => listDirectory(findProject(id), relativePath, offset));
  handle('project:file', (id, relativePath) => readProjectFile(findProject(id), relativePath));
  handle('project:reveal', async id => { const error = await shell.openPath(findProject(id).path); if (error) throw new Error(error); });
  handle('project:code', async (id, relativePath) => {
    const project = findProject(id);
    const target = relativePath ? await resolveProjectPath(project, relativePath) : project.path;
    const found = await new Promise(resolve => execFile('where.exe', ['code'], { windowsHide: true, timeout: 3000 }, (err, output) => resolve(err ? [] : output.trim().split(/\r?\n/))));
    const candidates = found.map(filename => path.join(path.dirname(path.dirname(filename)), 'Code.exe'));
    candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'));
    const executable = candidates.find(p => fs.existsSync(p));
    if (!executable) throw new Error('没有找到 VS Code。请将 VS Code 的 code 命令加入 PATH。');
    const child = spawn(executable, [target], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', report); child.unref();
  });
  handle('terminal:start', startTerminal);
  handle('terminal:restart', async id => {
    if (!await confirmTerminalClose(id, '重启')) return false;
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
      if (!s.codexActive && !isTerminalResponse(data)) { s.inputDirty = true; if (data.includes('\r') || data.includes('\n')) s.ready = false; }
      s.terminal.write(data);
      scheduleState();
    }
  });
  listen('terminal:resize', (id, cols, rows) => {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 250) return;
    const s = sessions.get(id);
    if (s && s.status !== 'exited') s.terminal.resize(cols, rows);
  });
  handle('clipboard:copy', text => { if (typeof text === 'string' && text.length <= 1024 * 1024) clipboard.writeText(text); });
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
    store = new WorkspaceStore(path.join(app.getPath('userData'), 'workspace.json'));
    runtimeDir = fs.mkdtempSync(path.join(app.getPath('userData'), 'runtime-'));
    eventServer = await createEventServer(onEvent);
    protocol.handle('project-grid', request => {
      const url = new URL(request.url);
      if (url.host !== 'app') return new Response('Not found', { status: 404 });
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const resolved = path.resolve(root, 'dist', relative);
      if (!resolved.startsWith(path.resolve(root, 'dist') + path.sep)) return new Response('Forbidden', { status: 403 });
      return electronNet.fetch(pathToFileURL(resolved).toString());
    });
    registerIpc();
    window = new BrowserWindow({
      width: 1500, height: 940, minWidth: 820, minHeight: 560,
      title: 'Project Grid · 项目矩阵', backgroundColor: '#101216',
      frame: false, show: false, icon: path.join(root, 'assets/icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.once('ready-to-show', () => window.show());
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
  }).catch(error => {
    dialog.showErrorBox('Project Grid 无法启动', String(error?.stack || error));
    app.exit(1);
  });
}
app.on('before-quit', () => {
  quitting = true;
  clearTimeout(stateTimer);
  for (const id of sessions.keys()) disposeTerminal(id);
  eventServer?.close();
  tray?.destroy();
  if (runtimeDir) {
    // Only this launch's generated, now-empty runtime directory is removed.
    try { fs.rmdirSync(runtimeDir); } catch { }
  }
});
app.on('window-all-closed', () => { if (quitting) app.quit(); });
