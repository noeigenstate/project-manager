import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  SquaresFour, FolderSimplePlus, Bell, BellSlash, MagnifyingGlass, ArrowsOutSimple,
  Play, Terminal as TerminalIcon, Check, DotsThree, GitBranch, X, Minus, Square,
  GearSix, CheckCircle, FolderOpen, Power, ArrowCounterClockwise,
  ArrowSquareOut, Monitor, Info, Circle, SpeakerHigh,
} from '@phosphor-icons/react';
import type { Project, Result, Settings, Workspace } from './types';
import { TerminalPane } from './TerminalPane';
import { ProjectExplorer } from './ProjectExplorer';
import { FilePreview } from './FilePreview';

const api = window.projectGrid;
type Filter = 'all' | 'unread' | 'done';

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
  if (project.done) return '开发完成';
  if (project.unread) return '等待你查看';
  if (project.error) return '需要检查';
  if (project.status === 'codex') return 'Codex 会话中';
  if (project.status === 'shell') return '终端就绪';
  if (project.status === 'starting') return '正在启动';
  if (project.status === 'exited') return '终端已退出';
  return '尚未启动';
}

function ProjectPanel({ project, index, hidden, focused, fontSize, now, onFocus, onDone, onAction, onError }: {
  project: Project; index: number; hidden: boolean; focused: boolean; fontSize: number; now: number;
  onFocus: (id: string) => void; onDone: (project: Project) => void;
  onAction: <T>(promise: Promise<Result<T>>) => Promise<T | undefined>; onError: (message: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const hasTerminal = !!project.sessionId;
  const stopped = project.status === 'stopped' || project.status === 'exited';
  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [menuOpen]);
  const action = (callback: () => void) => { setMenuOpen(false); callback(); };
  return <article
    className={`project-panel ${project.unread && !project.done ? 'has-unread' : ''} ${project.done ? 'is-done' : ''} ${focused ? 'is-focused' : ''} ${project.error ? 'has-error' : ''}`}
    data-project-id={project.id} data-status={project.done ? 'done' : project.unread ? 'unread' : project.status}
    style={{ display: hidden ? 'none' : undefined }}
    onClick={event => {
      if (!focused && project.unread && !(event.target as Element).closest('button, input, [role="menu"]')) onFocus(project.id);
    }}
  >
    <header className="panel-header">
      <span className="panel-index">{String(index + 1).padStart(2, '0')}</span>
      <button className="panel-name" onClick={() => !focused && onFocus(project.id)} title={project.path}>
        <span>{project.name}</span>
        {project.branch && <small><GitBranch size={11} />{project.branch}</small>}
      </button>
      <span className={`status-badge ${project.done ? 'green' : project.unread ? 'red' : project.error ? 'amber' : project.codexActive ? 'blue' : ''}`}>
        {project.done ? <CheckCircle size={13} weight="fill" /> : <span className="status-dot" />}
        <span>{statusText(project)}</span>
      </span>
      {!focused && <IconButton label={`全屏查看 ${project.name}`} onClick={() => onFocus(project.id)}><ArrowsOutSimple size={16} /></IconButton>}
      <div className="panel-menu-anchor" ref={menu}>
        <IconButton label={`${project.name} 的更多操作`} onClick={() => setMenuOpen(!menuOpen)}><DotsThree size={20} weight="bold" /></IconButton>
        {menuOpen && <div className="dropdown panel-menu" role="menu">
          <button role="menuitem" onClick={() => action(() => onDone(project))}><CheckCircle size={16} />{project.done ? '继续开发' : '标记开发完成'}</button>
          <button role="menuitem" onClick={() => action(() => { onAction(api.openInCode(project.id)); })}><ArrowSquareOut size={16} />在 VS Code 打开</button>
          <button role="menuitem" onClick={() => action(() => { onAction(api.revealProject(project.id)); })}><FolderOpen size={16} />打开项目目录</button>
          <button role="menuitem" onClick={() => action(() => { onAction(api.restartTerminal(project.id)); })}><ArrowCounterClockwise size={16} />重启终端</button>
          <div className="menu-divider" />
          <button role="menuitem" className="danger-text" onClick={() => action(() => { onAction(api.removeProject(project.id)); })}><X size={16} />移除项目</button>
        </div>}
      </div>
    </header>
    <div className="panel-terminal-area">
      {hasTerminal && <TerminalPane id={project.id} sessionId={project.sessionId} fontSize={fontSize} focused={focused} onError={onError} />}
      {!hasTerminal && <div className="terminal-empty">
        <TerminalIcon size={28} weight="light" />
        <p>{project.done ? '这个项目已标记为开发完成' : '项目已就位'}</p>
        <span>{project.done ? '需要继续时，随时启动终端' : '启动终端，在这里开始开发'}</span>
        <button className="button secondary small" onClick={() => onAction(api.startTerminal(project.id))}><Play size={13} weight="fill" />启动终端</button>
      </div>}
      {!!project.unread && !focused && !project.done && <button className="attention-overlay" onClick={() => onFocus(project.id)} aria-label={`查看 ${project.name} 的完成结果`}>
        <span className="attention-callout"><span className="attention-ping" /><span>本轮已完成，点击继续</span><ArrowsOutSimple size={14} /></span>
      </button>}
    </div>
    {project.error && <div className="panel-error"><Info size={13} /><span>{project.error}</span></div>}
    <footer className="panel-footer">
      <span className="panel-meta" title={project.path}>
        {project.done ? <CheckCircle size={12} /> : <TerminalIcon size={12} />}
        {project.done ? '已完成' : 'PowerShell'}
        <span className="meta-separator">/</span>
        <span>{project.lastCompletedAt ? `${relativeTime(project.lastCompletedAt, now)}完成一轮` : stopped ? '本地项目' : '独立终端'}</span>
      </span>
      <div className="panel-footer-actions">
        {project.unread > 1 && !project.done && <span className="unread-count">{project.unread} 轮未查看</span>}
        {stopped && hasTerminal && <button className="text-button" onClick={() => onAction(api.startTerminal(project.id))}><Play size={12} weight="fill" />重新启动</button>}
        {!stopped && !project.codexActive && project.status !== 'starting' && <button className="text-button" disabled={!project.shellReady} title="在空白终端提示符下启动 Codex" onClick={() => onAction(api.launchCodex(project.id))}><Play size={12} weight="fill" />启动 Codex</button>}
        {project.codexActive && <span className="session-label"><span className="session-dot" />CODEX</span>}
      </div>
    </footer>
  </article>;
}

function SettingsDialog({ settings, close, update, quit }: {
  settings: Settings; close: () => void; update: (patch: Partial<Settings>) => void; quit: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="settings-dialog" ref={dialog} onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="dialog-content">
      <div className="dialog-heading"><div><span className="eyebrow">PREFERENCES</span><h2>工作台设置</h2></div><IconButton label="关闭设置" onClick={close}><X size={18} /></IconButton></div>
      <p className="settings-intro">按照你的开发习惯调整提醒和终端。</p>
      <label className="setting-row"><span><Bell size={19} /><span><b>桌面通知</b><small>Codex 本轮结束时发送系统通知</small></span></span><input type="checkbox" checked={settings.notifications} onChange={e => update({ notifications: e.target.checked })} /></label>
      <label className="setting-row"><span><SpeakerHigh size={19} /><span><b>通知声音</b><small>播放系统默认提示音</small></span></span><input type="checkbox" checked={settings.sound} onChange={e => update({ sound: e.target.checked })} /></label>
      <label className="setting-row"><span><Monitor size={19} /><span><b>关闭到托盘</b><small>关闭窗口后，终端和任务继续运行</small></span></span><input type="checkbox" checked={settings.closeToTray} onChange={e => update({ closeToTray: e.target.checked })} /></label>
      <label className="setting-row"><span><TerminalIcon size={19} /><span><b>终端字号</b><small>全屏与网格共用字号</small></span></span><select aria-label="终端字号" value={settings.fontSize} onChange={e => update({ fontSize: Number(e.target.value) })}>{[10, 11, 12, 13, 14, 16, 18, 20].map(n => <option key={n} value={n}>{n} px</option>)}</select></label>
      <div className="settings-note"><Info size={15} /><p>红色闪烁表示一轮结束、等待查看；绿色常亮表示你已确认项目开发完成。减少动态效果的系统设置会同时关闭闪烁。</p></div>
      <div className="dialog-footer"><button className="text-button danger-text" onClick={quit}><Power size={15} />退出应用</button><button className="button primary" onClick={close}>完成</button></div>
    </div>
  </dialog>;
}

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [adding, setAdding] = useState(false);
  const [expandedByProject, setExpandedByProject] = useState<Record<string, string[]>>({});
  const [previewFile, setPreviewFile] = useState<{ projectId: string; path: string } | null>(null);
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
  const focusProject = useCallback((id: string) => {
    setPreviewFile(null);
    setFocusedId(id);
    api.focusMode(true);
    perform(api.acknowledge(id));
  }, [perform]);
  const returnToGrid = useCallback(() => { setFocusedId(null); setPreviewFile(null); api.focusMode(false); }, []);

  useEffect(() => {
    if (!api) return;
    const offState = api.onState(setWorkspace);
    const offFocus = api.onFocusProject(focusProject);
    const offError = api.onError(reportError);
    perform(api.getState()).then(state => { if (state) setWorkspace(state); });
    const clock = setInterval(() => setNow(Date.now()), 5000);
    return () => { offState(); offFocus(); offError(); clearInterval(clock); if (errorTimer.current) clearTimeout(errorTimer.current); };
  }, [focusProject, perform, reportError]);
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
  const unread = projects.filter(p => p.unread > 0 && !p.done).length;
  const done = projects.filter(p => p.done).length;
  const active = projects.filter(p => p.codexActive && !p.done).length;
  const visible = projects.filter(p =>
    (filter === 'all' || (filter === 'unread' ? p.unread > 0 && !p.done : p.done)) &&
    (!query || `${p.name} ${p.path}`.toLowerCase().includes(query.toLowerCase()))
  );
  const visibleIds = new Set(visible.map(p => p.id));
  const columns = settings.columns || Math.min(4, Math.max(1, Math.ceil(Math.sqrt(Math.max(visible.length, 1)))));
  const rows = Math.max(1, Math.ceil(visible.length / columns));
  const focus = projects.find(p => p.id === focusedId);
  const addProjects = async () => {
    setAdding(true);
    try { const ids = await perform(api.addProjects()); if (ids?.length) { setFilter('all'); setQuery(''); } }
    finally { setAdding(false); }
  };
  const markDone = async (project: Project) => {
    await perform(api.markDone(project.id, !project.done));
    if (focusedId && !project.done) returnToGrid();
  };
  const setPreference = (patch: Partial<Settings>) => { perform(api.settings(patch)); };

  return <div className={`app-shell ${focusedId ? 'focus-mode' : ''}`}>
    <div className="titlebar">
      <div className="titlebar-brand"><span className="brand-mark"><i /><i /><i /><i /></span><span>Project Grid</span><span className="titlebar-divider" /> <span className="titlebar-subtitle">项目矩阵</span></div>
      <div className="titlebar-center">{focusedId ? '专注模式' : '本地工作区'}</div>
      <div className="window-actions"><IconButton label="最小化" onClick={() => api.minimize()}><Minus size={16} /></IconButton><IconButton label="最大化或还原" onClick={() => api.maximize()}><Square size={12} /></IconButton><IconButton label="关闭窗口" className="window-close" onClick={() => api.close()}><X size={17} /></IconButton></div>
    </div>
    <div className="workspace-layout">
      {focus && <ProjectExplorer key={focus.id} project={focus} collapsed={settings.explorerCollapsed}
        expandedPaths={expandedByProject[focus.id] ?? ['']} selectedFile={previewFile?.projectId === focus.id ? previewFile.path : null}
        onCollapse={() => setPreference({ explorerCollapsed: !settings.explorerCollapsed })}
        onExpandedChange={paths => setExpandedByProject(value => ({ ...value, [focus.id]: paths }))}
        onSelectFile={path => setPreviewFile({ projectId: focus.id, path })} onReturn={returnToGrid} onDone={() => markDone(focus)}
        onSettings={() => setSettingsOpen(true)} onOpenCode={() => perform(api.openInCode(focus.id))} />}
      <main className="main-workspace">
        {!focusedId && <>
          <div className="workspace-header">
            <div><div className="workspace-heading"><h1>{filter === 'all' ? '全部项目' : filter === 'unread' ? '等待查看' : '开发完成'}</h1><span className="heading-count">{filter === 'all' ? projects.length : filter === 'unread' ? unread : done}</span></div><p>{projects.length ? `${active} 个 Codex 会话中${unread ? `，${unread} 个项目等待你查看` : '，所有项目尽在眼前'}` : '将项目放在一起，让每一次完成都看得见。'}</p></div>
            <div className="workspace-header-actions">
              <div className="search-input"><MagnifyingGlass size={16} /><input ref={queryInput} placeholder="搜索项目或路径…" aria-label="搜索项目" value={query} onChange={e => setQuery(e.target.value)} />{query ? <IconButton label="清除搜索" onClick={() => setQuery('')}><X size={13} /></IconButton> : <kbd>Ctrl K</kbd>}</div>
              <button className="button primary" onClick={addProjects} disabled={adding}><FolderSimplePlus size={17} />{adding ? '选择目录中…' : '添加项目'}</button>
              <IconButton label="工作台设置" onClick={() => setSettingsOpen(true)}><GearSix size={19} /></IconButton>
            </div>
          </div>
          <div className="grid-toolbar">
            <nav className="project-filters" aria-label="项目分类">
              <button className={filter === 'all' ? 'selected' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}><SquaresFour size={15} /><span>全部项目</span><b>{projects.length}</b></button>
              <button className={`${filter === 'unread' ? 'selected' : ''} ${unread ? 'nav-attention' : ''}`} aria-pressed={filter === 'unread'} onClick={() => setFilter('unread')}><span className="filter-dot red" /><span>等待查看</span><b>{unread}</b></button>
              <button className={filter === 'done' ? 'selected' : ''} aria-pressed={filter === 'done'} onClick={() => setFilter('done')}><span className="filter-dot green" /><span>开发完成</span><b>{done}</b></button>
            </nav>
            <div className="toolbar-right">
              <div className="layout-selector" aria-label="网格列数"><span>布局</span>{[0, 2, 3, 4].map(n => <button title={n ? `${n} 列` : '自动布局'} key={n} aria-label={n ? `${n} 列布局` : '自动布局'} className={settings.columns === n ? 'chosen' : ''} onClick={() => setPreference({ columns: n })}>{n === 0 ? '自动' : <><span className={`layout-glyph cols-${n}`}>{Array.from({ length: n }, (_, i) => <i key={i} />)}</span><span>{n}</span></>}</button>)}</div>
              <span className="toolbar-divider" />
              <IconButton label={settings.notifications ? '关闭桌面通知' : '开启桌面通知'} className={settings.notifications ? 'notifications-on' : ''} onClick={() => setPreference({ notifications: !settings.notifications })}>{settings.notifications ? <Bell size={17} /> : <BellSlash size={17} />}</IconButton>
            </div>
          </div>
        </>}
        {workspace.warning && <div className="workspace-warning"><Info size={15} />{workspace.warning}</div>}
        {focusedId && previewFile?.projectId === focusedId && <FilePreview projectId={focusedId} filePath={previewFile.path} onClose={() => setPreviewFile(null)} onError={reportError} />}
        <div className={`grid-area ${!projects.length ? 'empty-area' : ''}`} style={{ display: focusedId && previewFile?.projectId === focusedId ? 'none' : undefined }}>
          {!projects.length ? <div className="empty-workspace">
            <div className="empty-illustration" aria-hidden="true"><div className="illustration-tile"><span /><i /><i /><i /></div><div className="illustration-tile red-tile"><span /><i /><i /><b /></div><div className="illustration-tile green-tile"><Check size={22} /></div><div className="illustration-tile"><span /><i /><i /></div></div>
            <span className="eyebrow">你的多项目工作台</span><h2>每个项目，一个方框。</h2><p>添加项目目录，在独立终端里运行 Codex。<br />红框亮起时，点击全屏查看，再继续下一轮。</p>
            <button className="button primary" onClick={addProjects} disabled={adding}><FolderSimplePlus size={18} />添加第一个项目</button>
            <div className="empty-hints"><span><Circle weight="fill" size={7} />红色闪烁 · 等待查看</span><span><CheckCircle weight="fill" size={12} />绿色常亮 · 开发完成</span></div>
          </div> : <>
            {!focusedId && !visible.length && <div className="no-results"><MagnifyingGlass size={30} weight="light" /><h2>{query ? '没有找到匹配项目' : filter === 'unread' ? '暂时没有待查看的项目' : '还没有已完成的项目'}</h2><p>{query ? '试试其他项目名称或目录。' : filter === 'unread' ? 'Codex 本轮结束后，项目会在这里亮起。' : '在项目全屏视图中点击“标记开发完成”。'}</p><button className="button secondary small" onClick={() => { setFilter('all'); setQuery(''); }}>查看全部项目</button></div>}
            <div className="project-grid" style={{ '--columns': columns, '--rows': rows, display: !focusedId && !visible.length ? 'none' : undefined } as CSSProperties}>
              {projects.map((project, index) => <ProjectPanel key={project.id} project={project} index={index}
                hidden={focusedId ? focusedId !== project.id : !visibleIds.has(project.id)} focused={focusedId === project.id && !previewFile}
                fontSize={settings.fontSize} now={now} onFocus={focusProject} onDone={markDone} onAction={perform} onError={reportError} />)}
            </div>
          </>}
        </div>
        <footer className="workspace-statusbar"><span><span className="connection-dot" />本地工作区<span className="statusbar-divider">/</span>{projects.length} 个项目</span><span>{focusedId ? <><kbd>Ctrl Shift G</kbd>返回总览</> : <><span className="legend-red" />{unread} 个待查看<span className="legend-green" />{done} 个已完成</>}</span></footer>
      </main>
    </div>
    {error && <div className="error-toast" role="alert"><Info size={18} /><span>{error}</span><IconButton label="关闭提示" onClick={() => setError(null)}><X size={16} /></IconButton></div>}
    {settingsOpen && <SettingsDialog settings={settings} close={() => setSettingsOpen(false)} update={setPreference} quit={() => perform(api.quit())} />}
  </div>;
}
