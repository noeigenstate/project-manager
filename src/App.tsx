import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  SquaresFour, FolderSimplePlus, Bell, MagnifyingGlass, ArrowsOutSimple,
  Play, Plus, Terminal as TerminalIcon, Check, DotsThree, GitBranch, X, Minus, Square,
  GearSix, CheckCircle, FolderOpen, Power, ArrowCounterClockwise,
  ArrowSquareOut, Monitor, Info, Circle, SpeakerHigh, Globe, Microphone,
} from '@phosphor-icons/react';
import type { AppUpdateState, Project, Result, Settings, SSHAuthPrompt, Workspace } from './types';
import { ProjectTerminals } from './ProjectTerminals';
import { ProjectExplorer } from './ProjectExplorer';
import { AddProjectDialog } from './AddProjectDialog';
import { SSHAuthDialog } from './SSHAuthDialog';
import { useProjectReorder } from './useProjectReorder';
import { useProjectFocusMotion } from './useProjectFocusMotion';
import { applyTheme, themes } from './themes';
const VoiceDialog = lazy(() => import('./VoiceDialog').then(module => ({ default: module.VoiceDialog })));
const FilePreview = lazy(() => import('./FilePreview').then(module => ({ default: module.FilePreview })));

const api = window.projectGrid;

function IconButton({ label, children, onClick, className = '', disabled = false }: {
  label: string; children: ReactNode; onClick: () => void; className?: string; disabled?: boolean;
}) {
  return <button className={`icon-button ${className}`} type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>;
}

function relativeTime(timestamp: number | null, now: number) {
  if (!timestamp) return '';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 10) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}

function statusText(project: Project) {
  if (project.codexActive && project.codexActivity === 'working') return '正在处理';
  if (project.done) return '开发完成';
  if (project.unread) return '等待你查看';
  if (project.error) return '需要检查';
  if (project.status === 'codex') return project.codexActivity === 'complete' ? '本轮已完成' : project.codexActivity === 'interrupted' ? '已中断' : 'Codex 会话中';
  if (project.status === 'shell') return '终端就绪';
  if (project.status === 'starting') return project.kind === 'ssh' ? '正在连接 SSH' : '正在启动';
  if (project.status === 'exited') return project.kind === 'ssh' ? 'SSH 终端已退出' : '终端已退出';
  return '尚未启动';
}

function ProjectPanel({ project, index, hidden, focused, fontSize, now, onFocus, onDone, onAction, onError, onOpenLink, dragging, dropTarget, onVoice }: {
  project: Project; index: number; hidden: boolean; focused: boolean; fontSize: number; now: number;
  onFocus: (id: string) => void; onDone: (project: Project) => void;
  onAction: <T>(promise: Promise<Result<T>>) => Promise<T | undefined>; onError: (message: string) => void;
  onOpenLink: (id: string, target: string) => void;
  dragging?: boolean; dropTarget?: boolean;
  onVoice: (project: Project) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const first = project.terminals[0];
  const currentTerminal = project.terminals.find(item => item.id === activeTerminalId) || first;
  const multiple = project.terminals.length > 1;
  const hasTerminal = !!first.sessionId;
  const stopped = first.status === 'stopped' || first.status === 'exited';
  const addTerminal = async () => { const id = await onAction(api.addTerminal(project.id)); if (id) setActiveTerminalId(id); };
  const completionAge = project.lastCompletedAt === null ? Infinity : Date.now() - project.lastCompletedAt;
  const working = project.codexActive && project.codexActivity === 'working';
  const freshCompletion = !!project.unread && !project.done && !working && completionAge >= 0 && completionAge < 9000;
  const roundComplete = project.codexActive && project.codexActivity === 'complete' && !project.unread && !project.done && !project.error;
  // A new turn starts the edge and dot together; ordinary renders keep their clock.
  const signalKey = `${working ? 'working' : 'rest'}:${project.lastCompletedAt}`;
  const badgeClass = `status-badge ${working ? 'blue' : project.done || roundComplete ? 'green' : project.unread ? 'red' : project.error ? 'amber' : ''}`;
  const badge = <><span key={signalKey} className="status-dot" aria-hidden="true" /><span>{statusText(project)}</span></>;
  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [menuOpen]);
  const action = (callback: () => void) => { setMenuOpen(false); callback(); };
  return <article
    className={`project-panel ${project.unread && !project.done && !working ? 'has-unread' : ''} ${freshCompletion ? 'attention-active' : ''} ${project.done && !working ? 'is-done' : ''} ${working ? 'is-working' : ''} ${roundComplete ? 'round-complete' : ''} ${focused ? 'is-focused' : ''} ${project.error ? 'has-error' : ''} ${dragging ? 'drag-source' : ''} ${dropTarget ? 'drop-target' : ''}`}
    data-project-id={project.id} data-status={working ? 'working' : project.done ? 'done' : project.unread ? 'unread' : project.status}
    style={{ display: hidden ? 'none' : undefined }}
  >
    <span key={signalKey} className="panel-signal" aria-hidden="true" />
    <header className="panel-header" title={focused ? undefined : '点击标题栏放大，按住标题栏拖动排序'} onClick={event => {
      if (!focused && event.button === 0 && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && !(event.target as Element).closest('button, [role="menu"]')) onFocus(project.id);
    }}>
      <span className="panel-index">{String(index + 1).padStart(2, '0')}</span>
      <button className="panel-name" onClick={() => !focused && onFocus(project.id)} title={project.kind === 'ssh' ? `${project.ssh?.host}:${project.path}` : project.path}>
        <span>{project.name}</span>
        {project.branch && <small><GitBranch size={11} />{project.branch}</small>}
        {project.kind === 'ssh' && <small className="ssh-project-label"><Globe size={11} />{project.ssh?.host}</small>}
      </button>
      {!!project.unread && !focused && !project.done && !working
        ? <button type="button" className={`${badgeClass} status-button`} title={statusText(project)} onClick={() => onFocus(project.id)} aria-label={`查看 ${project.name} 的完成结果`}>{badge}</button>
        : <span className={badgeClass} title={statusText(project)}>{badge}</span>}
      <IconButton label={`新增终端 ${project.name}`} onClick={() => void addTerminal()}><Plus size={16} /></IconButton>
      {!focused && <IconButton label={`全屏查看 ${project.name}`} onClick={() => onFocus(project.id)}><ArrowsOutSimple size={16} /></IconButton>}
      <div className="panel-menu-anchor" ref={menu}>
        <IconButton label={`${project.name} 的更多操作`} onClick={() => setMenuOpen(!menuOpen)}><DotsThree size={20} weight="bold" /></IconButton>
        {menuOpen && <div className="dropdown panel-menu" role="menu">
          <button role="menuitem" onClick={() => action(() => void addTerminal())}><Plus size={16} />新建终端并分屏</button>
          <button role="menuitem" onClick={() => action(() => onDone(project))}><CheckCircle size={16} />{project.done ? '继续开发' : '标记开发完成'}</button>
          <button role="menuitem" onClick={() => action(() => { onAction(api.openInCode(project.id)); })}><ArrowSquareOut size={16} />在 VS Code 打开</button>
          <button role="menuitem" onClick={() => action(() => { onAction(api.revealProject(project.id)); })}><FolderOpen size={16} />打开项目目录</button>
          <button role="menuitem" onClick={() => action(() => { onAction(api.restartTerminal(currentTerminal.id)); })}><ArrowCounterClockwise size={16} />{project.kind === 'ssh' ? '重新连接 SSH' : '重启当前终端'}</button>
          <div className="menu-divider" />
          <button role="menuitem" className="danger-text" onClick={() => action(() => { onAction(api.removeProject(project.id)); })}><X size={16} />移除项目</button>
        </div>}
      </div>
    </header>
    <ProjectTerminals project={project} focused={focused} fontSize={fontSize} activeId={activeTerminalId} setActiveId={setActiveTerminalId} onAction={onAction} onError={onError} onOpenLink={onOpenLink} onVoice={onVoice} />
    {project.error && <div className="panel-error"><Info size={13} /><span>{project.error}</span></div>}
    <footer className="panel-footer">
      <span className="panel-meta" title={project.path}>
        {project.done ? <CheckCircle size={12} /> : <TerminalIcon size={12} />}
        {project.done ? '已完成' : project.kind === 'ssh' ? `SSH · ${project.ssh?.host}` : 'PowerShell'}
        <span className="meta-separator">/</span>
        <span>{working ? '任务进行中' : project.lastCompletedAt ? `${relativeTime(project.lastCompletedAt, now)}完成一轮` : stopped ? project.kind === 'ssh' ? '远程项目' : '本地项目' : '独立终端'}</span>
      </span>
      <div className="panel-footer-actions">
        {!multiple && <IconButton label={`语音输入 ${project.name}`} className="voice-button" onClick={() => onVoice({ ...project, id: first.id, sessionId: first.sessionId })}><Microphone size={14} /></IconButton>}
        {multiple && <span className="session-label">{project.terminals.length} 个终端</span>}
        {project.unread > 1 && !project.done && <span className="unread-count">{project.unread} 轮未查看</span>}
        {!multiple && stopped && hasTerminal && <button className="text-button" onClick={() => onAction(api.startTerminal(first.id))}><Play size={12} weight="fill" />重新启动</button>}
        {!multiple && !stopped && !first.codexActive && first.status !== 'starting' && <button className="text-button" disabled={!first.shellReady} title="在空白终端提示符下启动 Codex" onClick={() => onAction(api.launchCodex(first.id))}><Play size={12} weight="fill" />启动 Codex</button>}
        {!multiple && first.codexActive && <span className="session-label"><span className="session-dot" />CODEX</span>}
      </div>
    </footer>
  </article>;
}

function SettingsDialog({ settings, updates, onCheckUpdate, onInstallUpdate, onDownloadPage, close, update, quit, onVoice }: {
  settings: Settings; close: () => void; update: (patch: Partial<Settings>) => void; quit: () => void;
  updates: AppUpdateState | null; onCheckUpdate: () => void; onInstallUpdate: () => void; onDownloadPage: () => void;
  onVoice: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="settings-dialog" ref={dialog} onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="dialog-content">
      <div className="dialog-heading"><div><span className="eyebrow">PREFERENCES</span><h2>工作台设置</h2></div><IconButton label="关闭设置" onClick={close}><X size={18} /></IconButton></div>
      <p className="settings-intro">按照你的开发习惯调整提醒和终端。</p>
      <fieldset className="theme-picker"><legend>外观主题</legend><div className="theme-options">
        {themes.map(theme => <label key={theme.id} className={`theme-option ${settings.theme === theme.id ? 'is-selected' : ''}`}>
          <input type="radio" name="theme" value={theme.id} checked={settings.theme === theme.id} aria-label={theme.name} onChange={() => update({ theme: theme.id })} />
          <span className="theme-swatch" data-theme-preview={theme.id} aria-hidden="true"><span className="theme-mini-window"><i /><i /><i /></span><span className="theme-check"><Check size={12} weight="bold" /></span></span>
          <span className="theme-name">{theme.name}</span><small>{theme.description}</small>
        </label>)}
      </div></fieldset>
      <label className="setting-row"><span><Bell size={19} /><span><b>桌面通知</b><small>Codex 本轮结束时发送系统通知</small></span></span><input type="checkbox" checked={settings.notifications} onChange={e => update({ notifications: e.target.checked })} /></label>
      <label className="setting-row"><span><SpeakerHigh size={19} /><span><b>通知声音</b><small>播放系统默认提示音</small></span></span><input type="checkbox" checked={settings.sound} onChange={e => update({ sound: e.target.checked })} /></label>
      <label className="setting-row"><span><Monitor size={19} /><span><b>关闭到托盘</b><small>关闭窗口后，终端和任务继续运行</small></span></span><input type="checkbox" checked={settings.closeToTray} onChange={e => update({ closeToTray: e.target.checked })} /></label>
      <label className="setting-row"><span><TerminalIcon size={19} /><span><b>终端字号</b><small>全屏与网格共用字号</small></span></span><select aria-label="终端字号" value={settings.fontSize} onChange={e => update({ fontSize: Number(e.target.value) })}>{[10, 11, 12, 13, 14, 16, 18, 20].map(n => <option key={n} value={n}>{n} px</option>)}</select></label>
      <label className="setting-row"><span><ArrowsOutSimple size={19} /><span><b>窗口放大动画</b><small>点击标题栏平滑展开，返回时缩回原位</small></span></span><select aria-label="窗口放大动画" value={settings.focusAnimation} onChange={e => update({ focusAnimation: e.target.value as Settings['focusAnimation'] })}><option value="smooth">平滑缩放</option><option value="system">跟随系统</option><option value="off">关闭</option></select></label>
      <label className="setting-row"><span><ArrowCounterClockwise size={19} /><span><b>启动时恢复工作</b><small>恢复最近会话，被中断的任务自动发送“继续”</small></span></span><input type="checkbox" checked={settings.restoreSessions} onChange={event => update({ restoreSessions: event.target.checked })} /></label>
      <div className="setting-row"><span><Microphone size={19} /><span><b>本地语音输入</b><small>检测麦克风，下载离线识别模型</small></span></span><button className="button secondary small" onClick={onVoice}>语音设置</button></div>
      {updates && <section className="update-section" aria-label="应用更新">
        <div className="update-heading"><b>应用更新</b><span>当前版本 v{updates.currentVersion}</span></div>
        <p role="status">{updates.status === 'unavailable' ? '当前为便携版或开发版。安装 Windows 版后，即可自动检查和下载更新。'
          : updates.status === 'checking' ? '正在检查更新…'
          : updates.status === 'current' ? '当前已是最新版本。'
          : updates.status === 'downloading' ? `正在下载 v${updates.version} · ${updates.percent}%`
          : updates.status === 'ready' ? `v${updates.version} 已下载，可在方便时重启安装。`
          : updates.status === 'error' ? updates.error : '启动后自动检查更新，并在后台下载新版本。'}</p>
        {updates.status === 'downloading' && <progress aria-label="更新下载进度" max={100} value={updates.percent} />}
        <div className="update-actions">{!updates.supported
          ? <button className="button secondary small" onClick={onDownloadPage}>下载 Windows 安装版</button>
          : updates.status === 'ready' ? <button className="button primary small" onClick={onInstallUpdate}>重启并安装更新</button>
          : <button className="button secondary small" disabled={updates.status === 'checking' || updates.status === 'downloading'} onClick={onCheckUpdate}>{updates.status === 'error' ? '重试更新' : '检查更新'}</button>}</div>
      </section>}
      <div className="settings-note"><Info size={15} /><p>红色闪烁表示一轮结束、等待查看；绿色常亮表示你已确认项目开发完成。减少动态效果的系统设置会同时关闭闪烁。</p></div>
      <div className="dialog-footer"><button className="text-button danger-text" onClick={quit}><Power size={15} />退出应用</button><button className="button primary" onClick={close}>完成</button></div>
    </div>
  </dialog>;
}

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  useEffect(() => { if (workspace) applyTheme(workspace.settings.theme); }, [workspace?.settings.theme]);
  const [updates, setUpdates] = useState<AppUpdateState | null>(null);
  const [query, setQuery] = useState('');
  const { root: focusMotionRoot, focusedId, focus: setFocusedId } = useProjectFocusMotion(workspace?.settings.focusAnimation || 'smooth');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [addOpen, setAddOpen] = useState(false);
  const [sshAuth, setSSHAuth] = useState<SSHAuthPrompt[]>([]);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceTarget, setVoiceTarget] = useState<{ id: string; sessionId: string | null; name: string } | null>(null);
  const [expandedByProject, setExpandedByProject] = useState<Record<string, string[]>>({});
  const [previewFile, setPreviewFile] = useState<{ projectId: string; path: string } | null>(null);
  const editorGuard = useRef<(() => Promise<boolean>) | null>(null);
  const navigationGuard = useRef<Promise<boolean> | null>(null);
  const registerEditorGuard = useCallback((guard: (() => Promise<boolean>) | null) => { editorGuard.current = guard; }, []);
  const allowNavigation = useCallback(() => {
    if (navigationGuard.current) return navigationGuard.current;
    const promise = Promise.resolve(editorGuard.current?.() ?? true).finally(() => { navigationGuard.current = null; });
    navigationGuard.current = promise; return promise;
  }, []);
  const queryInput = useRef<HTMLInputElement>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportError = useCallback((message: string) => {
    setError(message);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 10000);
  }, []);
  const perform = useCallback(async <T,>(promise: Promise<Result<T>>) => {
    try { const result = await promise; if (!result.ok) { reportError(result.error); return; } return result.value; }
    catch (err) { reportError(String(err)); }
  }, [reportError]);
  const reorder = useProjectReorder(!focusedId && !addOpen && !settingsOpen && !voiceOpen && !sshAuth.length && (workspace?.projects.length || 0) > 1, query,
    workspace?.projects.map(project => project.id) || [], ids => perform(api.reorderProjects(ids)));
  const focusProject = useCallback(async (id: string) => {
    if (!await allowNavigation()) return false;
    setPreviewFile(null);
    setFocusedId(id);
    api.focusMode(true);
    perform(api.acknowledge(id));
    return true;
  }, [perform, setFocusedId, allowNavigation]);
  const returnToGrid = useCallback(async () => { if (!await allowNavigation()) return; setFocusedId(null); setPreviewFile(null); api.focusMode(false); }, [setFocusedId, allowNavigation]);
  const openTerminalLink = useCallback(async (id: string, target: string) => {
    const result = await perform(api.openLink(id, target));
    if (result?.kind === 'file') {
      if (!await focusProject(id)) return;
      setPreviewFile({ projectId: id, path: result.path });
    }
  }, [perform, focusProject]);

  useEffect(() => {
    if (!api) return;
    const offState = api.onState(setWorkspace);
    const offFocus = api.onFocusProject(focusProject);
    const offError = api.onError(reportError);
    const offUpdates = api.onUpdateState(setUpdates);
    const offAuth = api.onSSHAuth(setSSHAuth);
    const offEditor = api.onEditorClose(id => { void allowNavigation().then(accepted => api.editorCloseResult(id, accepted), () => api.editorCloseResult(id, false)); });
    perform(api.getSSHAuth()).then(requests => { if (requests) setSSHAuth(requests); });
    perform(api.getUpdateState()).then(state => { if (state) setUpdates(state); });
    perform(api.getState()).then(state => { if (state) setWorkspace(state); });
    const clock = setInterval(() => setNow(Date.now()), 5000);
    return () => { offState(); offFocus(); offError(); offUpdates(); offAuth(); offEditor(); clearInterval(clock); if (errorTimer.current) clearTimeout(errorTimer.current); };
  }, [focusProject, perform, reportError, allowNavigation]);
  useEffect(() => {
    if (focusedId && workspace && !workspace.projects.some(p => p.id === focusedId)) returnToGrid();
  }, [workspace, focusedId, returnToGrid]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'g') { event.preventDefault(); event.stopPropagation(); returnToGrid(); }
      if (!focusedId && event.ctrlKey && event.key.toLowerCase() === 'k') { event.preventDefault(); event.stopPropagation(); queryInput.current?.focus(); }
      if (focusedId && event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'b') { event.preventDefault(); event.stopPropagation(); perform(api.settings({ explorerCollapsed: !workspace?.settings.explorerCollapsed })); }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [focusedId, returnToGrid, perform, workspace?.settings.explorerCollapsed]);

  if (!api) return <div className="startup-message"><SquaresFour size={38} /><h1>Project Grid 是桌面应用</h1><p>请在项目目录运行 npm start，或双击打包后的应用。</p></div>;
  if (!workspace) return <div className="startup-message"><SquaresFour size={34} /><p>{error || '正在打开工作区…'}</p></div>;
  const { projects, settings } = workspace;
  const projectRecords = new Map(projects.map(project => [project.id, project]));
  const orderedProjects = reorder.order ? reorder.order.flatMap(id => projectRecords.get(id) || []) : projects;
  const unread = projects.filter(p => p.unread > 0 && !p.done).length;
  const done = projects.filter(p => p.done).length;
  const visible = projects.filter(p => !query || `${p.name} ${p.path} ${p.ssh?.host || ''}`.toLowerCase().includes(query.toLowerCase()));
  const visibleIds = new Set(visible.map(p => p.id));
  const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(Math.max(visible.length, 1)))));
  const rows = Math.max(1, Math.ceil(visible.length / columns));
  const focus = projects.find(p => p.id === focusedId);
  const markDone = async (project: Project) => {
    if (!await allowNavigation()) return;
    await perform(api.markDone(project.id, !project.done));
    if (focusedId && !project.done) returnToGrid();
  };
  const setPreference = (patch: Partial<Settings>) => { perform(api.settings(patch)); };

  return <div ref={focusMotionRoot} className={`app-shell ${focusedId ? 'focus-mode' : ''}`}>
    <div className="titlebar">
      <div className="titlebar-brand"><span className="brand-mark"><i /><i /><i /><i /></span><span>Project Grid</span><span className="titlebar-divider" /> <span className="titlebar-subtitle">项目矩阵</span></div>
      <div className="titlebar-space" />
      {!focusedId && <div className="titlebar-tools">
        <div className="search-input"><MagnifyingGlass size={16} /><input ref={queryInput} placeholder="搜索项目或路径…" aria-label="搜索项目" value={query} onChange={e => setQuery(e.target.value)} />{query ? <IconButton label="清除搜索" onClick={() => setQuery('')}><X size={13} /></IconButton> : <kbd>Ctrl K</kbd>}</div>
        <button className="button primary" onClick={() => setAddOpen(true)}><FolderSimplePlus size={17} />添加项目</button>
        <IconButton label="工作台设置" className={updates?.status === 'ready' ? 'update-ready' : ''} onClick={() => setSettingsOpen(true)}><GearSix size={19} /></IconButton>
      </div>}
      <div className="window-actions"><IconButton label="最小化" onClick={() => api.minimize()}><Minus size={16} /></IconButton><IconButton label="最大化或还原" onClick={() => api.maximize()}><Square size={12} /></IconButton><IconButton label="关闭窗口" className="window-close" onClick={() => api.close()}><X size={17} /></IconButton></div>
    </div>
    <div className="workspace-layout">
      {focus && <ProjectExplorer key={focus.id} project={focus} collapsed={settings.explorerCollapsed}
        onFilesRemoved={paths => setPreviewFile(current => current?.projectId === focus.id && paths.some(path => current.path === path || current.path.startsWith(path + '/')) ? null : current)}
        onPathRenamed={(oldPath, newPath) => setPreviewFile(current => current?.projectId === focus.id && (current.path === oldPath || current.path.startsWith(oldPath + '/')) ? { projectId: focus.id, path: newPath + current.path.slice(oldPath.length) } : current)}
        expandedPaths={expandedByProject[focus.id] ?? ['']} selectedFile={previewFile?.projectId === focus.id ? previewFile.path : null}
        onCollapse={() => setPreference({ explorerCollapsed: !settings.explorerCollapsed })}
        onExpandedChange={paths => setExpandedByProject(value => ({ ...value, [focus.id]: paths }))}
        onSelectFile={async path => { if (previewFile?.projectId === focus.id && previewFile.path === path) return; if (await allowNavigation()) setPreviewFile({ projectId: focus.id, path }); }} onReturn={returnToGrid} onDone={() => markDone(focus)}
        onSettings={() => setSettingsOpen(true)} onOpenCode={() => perform(api.openInCode(focus.id))} />}
      <main className="main-workspace">
        {workspace.warning && <div className="workspace-warning"><Info size={15} />{workspace.warning}</div>}
        {focusedId && previewFile?.projectId === focusedId && <Suspense fallback={null}><FilePreview key={`${focusedId}:${previewFile.path}`} projectId={focusedId} filePath={previewFile.path} onClose={async () => { if (await allowNavigation()) setPreviewFile(null); }} onOpenFile={async path => { if (await allowNavigation()) setPreviewFile({ projectId: focusedId, path }); }} onError={reportError} registerGuard={registerEditorGuard} /></Suspense>}
        <div className={`grid-area ${!projects.length ? 'empty-area' : ''}`} style={{ visibility: focusedId && previewFile?.projectId === focusedId ? 'hidden' : undefined }}>
          {!projects.length ? <div className="empty-workspace">
            <div className="empty-illustration" aria-hidden="true"><div className="illustration-tile"><span /><i /><i /><i /></div><div className="illustration-tile red-tile"><span /><i /><i /><b /></div><div className="illustration-tile green-tile"><Check size={22} /></div><div className="illustration-tile"><span /><i /><i /></div></div>
            <span className="eyebrow">你的多项目工作台</span><h2>每个项目，一个方框。</h2><p>添加项目目录，在独立终端里运行 Codex。<br />红框亮起时，点击全屏查看，再继续下一轮。</p>
            <button className="button primary" onClick={() => setAddOpen(true)}><FolderSimplePlus size={18} />添加第一个项目</button>
            <div className="empty-hints"><span><Circle weight="fill" size={7} />红色闪烁 · 等待查看</span><span><CheckCircle weight="fill" size={12} />绿色常亮 · 开发完成</span></div>
          </div> : <>
            {!focusedId && !visible.length && <div className="no-results"><MagnifyingGlass size={30} weight="light" /><h2>没有找到匹配项目</h2><p>试试其他项目名称或目录。</p><button className="button secondary small" onClick={() => setQuery('')}>重置搜索</button></div>}
            <div className={`project-grid ${reorder.drag ? 'is-reordering' : ''}`} onPointerDown={reorder.onPointerDown} onClickCapture={reorder.onClickCapture} style={{ '--columns': columns, '--rows': rows, display: !focusedId && !visible.length ? 'none' : undefined } as CSSProperties}>
              {orderedProjects.map((project, index) => <div key={project.id} className={`project-slot ${reorder.drag?.id === project.id ? 'drag-placeholder' : ''}`} data-project-slot={project.id} style={{ display: focusedId ? focusedId !== project.id ? 'none' : undefined : !visibleIds.has(project.id) ? 'none' : undefined }}><ProjectPanel project={project} index={index}
                hidden={focusedId ? focusedId !== project.id : !visibleIds.has(project.id)} focused={focusedId === project.id && !previewFile}
                fontSize={settings.fontSize} now={now} onFocus={focusProject} onDone={markDone} onAction={perform} onError={reportError} onOpenLink={openTerminalLink}
                dragging={reorder.drag?.id === project.id} onVoice={project => { setVoiceTarget({ id: project.id, sessionId: project.sessionId, name: project.name }); setVoiceOpen(true); }} /> </div>)}
              {reorder.drag && <div className="reorder-hint" role="status">拖动项目排序 · 松开完成<span>Esc 取消</span></div>}
            </div>
          </>}
        </div>
        <footer className="workspace-statusbar"><span><span className="connection-dot" />{projects.some(project => project.kind === 'ssh') ? '本地与 SSH 工作区' : '本地工作区'}<span className="statusbar-divider">/</span>{projects.length} 个项目</span><span>{focusedId ? <><kbd>Ctrl Shift G</kbd>返回总览</> : <><span className="legend-red" />{unread} 个待查看<span className="legend-green" />{done} 个已完成</>}</span></footer>
      </main>
    </div>
    {error && <div className="error-toast" role="alert"><Info size={18} /><span>{error}</span><IconButton label="关闭提示" onClick={() => setError(null)}><X size={16} /></IconButton></div>}
    {settingsOpen && <SettingsDialog settings={settings} updates={updates} onCheckUpdate={() => { perform(api.checkForUpdates()); }} onInstallUpdate={() => { perform(api.installUpdate()); }} onDownloadPage={() => { perform(api.openDownloadPage()); }} close={() => setSettingsOpen(false)} update={setPreference} quit={() => perform(api.quit())} onVoice={() => { setSettingsOpen(false); setVoiceTarget(null); setVoiceOpen(true); }} />}
    {addOpen && <AddProjectDialog onClose={() => setAddOpen(false)} onAdded={() => setQuery('')} onError={reportError} />}
    {sshAuth[0] && <SSHAuthDialog key={sshAuth[0].id} request={sshAuth[0]} />}
    {voiceOpen && <Suspense fallback={null}><VoiceDialog target={voiceTarget} close={() => setVoiceOpen(false)} /></Suspense>}
  </div>;
}
