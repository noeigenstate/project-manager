import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import {
  ArrowLeft, ArrowsInLineVertical, ArrowClockwise, BracketsCurly,
  CaretDown, CaretRight, File, FileCode, FileText, Folder, FolderOpen,
  GearSix, GitBranch, LinkSimple, SidebarSimple, SpinnerGap, Image as ImageIcon, FilmStrip, FilePlus, FolderPlus, Clipboard,
} from '@phosphor-icons/react';
import type { DirectoryListing, FileEntry, Project } from './types';
import { useExplorerFileActions } from './ExplorerFileActions';
import { GitBadge, GitPanel } from './GitPanel';
import { gitDecorations, gitMark, type GitDecoration } from './git-status';
import { useGitStatus } from './useGitStatus';

export function FileIcon({ entry, open = false }: { entry: FileEntry; open?: boolean }) {
  if (entry.kind === 'directory') return open ? <FolderOpen className="file-icon folder-icon" size={16} weight="duotone" /> : <Folder className="file-icon folder-icon" size={16} weight="duotone" />;
  if (entry.kind === 'link') return <LinkSimple className="file-icon" size={15} />;
  if (/\.(png|apng|jpe?g|jpe|jfif|gif|webp|bmp|avif|svg|ico)$/i.test(entry.name)) return <ImageIcon className="file-icon code-icon" size={16} />;
  if (/\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi)$/i.test(entry.name)) return <FilmStrip className="file-icon config-icon" size={16} />;
  if (/\.(json|ya?ml|toml)$/i.test(entry.name)) return <BracketsCurly className="file-icon config-icon" size={15} />;
  if (/\.(tsx?|jsx?|[cm]js|py|rs|go|html?|css|scss|vue|svelte|ps1)$/i.test(entry.name)) return <FileCode className="file-icon code-icon" size={16} />;
  if (/\.(md|txt|log)$/i.test(entry.name)) return <FileText className="file-icon text-file-icon" size={16} />;
  if (/^(\.git|\.env)|config/i.test(entry.name)) return <GearSix className="file-icon" size={15} />;
  return <File className="file-icon" size={15} />;
}

function navigateTree(event: KeyboardEvent<HTMLButtonElement>, open: boolean, directory: boolean, toggle: () => void) {
  const tree = event.currentTarget.closest('[role="tree"]');
  const rows = [...(tree?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') || [])];
  const index = rows.indexOf(event.currentTarget);
  const level = Number(event.currentTarget.getAttribute('aria-level'));
  let target: HTMLButtonElement | undefined;
  if (event.key === 'ArrowDown') target = rows[index + 1];
  else if (event.key === 'ArrowUp') target = rows[index - 1];
  else if (event.key === 'Home') target = rows[0];
  else if (event.key === 'End') target = rows.at(-1);
  else if (event.key === 'ArrowRight') {
    if (directory && !open) toggle();
    else if (open && Number(rows[index + 1]?.getAttribute('aria-level')) > level) target = rows[index + 1];
  } else if (event.key === 'ArrowLeft') {
    if (directory && open) toggle();
    else target = rows.slice(0, index).reverse().find(row => Number(row.getAttribute('aria-level')) < level);
  } else return;
  event.preventDefault();
  event.stopPropagation();
  target?.focus();
}

type NodeProps = {
  projectId: string; entry: FileEntry; depth: number; expanded: Set<string>;
  revision: number; enabled: boolean; selectedFile: string | null;
  onToggle: (path: string) => void; onSelect: (path: string) => void;
  selected: Set<string>; choose: (entry: FileEntry, event: MouseEvent) => boolean; contextMenu: (entry: FileEntry, event: MouseEvent) => void;
  decorations: Map<string, GitDecoration>;
};

function TreeNode(props: NodeProps) {
  const { projectId, entry, depth, expanded, revision, enabled, selectedFile, onToggle, onSelect, selected, choose, contextMenu } = props;
  const isDirectory = entry.kind === 'directory';
  const open = isDirectory && expanded.has(entry.path);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pages, setPages] = useState(1);
  const root = depth === 0;
  const decoration = props.decorations.get(entry.path);
  const requestRefresh = useRef<(() => void) | null>(null);
  const lastRevision = useRef(revision);

  useEffect(() => {
    if (!open || !enabled) return;
    let active = true, running = false, queued = false;
    const refresh = async () => {
      if (!active) return;
      if (running) { queued = true; return; }
      running = true; setLoading(true);
      try {
        const entries: FileEntry[] = [];
        let offset: number | null = 0;
        let result: DirectoryListing | null = null;
        for (let page = 0; page < pages && offset !== null; page++) {
          const response = await window.projectGrid.listDirectory(projectId, entry.path, offset);
          if (!active) return;
          if (!response.ok) throw new Error(response.error);
          result = response.value;
          entries.push(...result.entries);
          if (result.nextOffset !== null && result.nextOffset <= offset) throw new Error('目录分页未前进，请刷新重试。');
          offset = result.nextOffset;
        }
        if (active && result) { setListing({ ...result, entries }); setError(''); }
      } catch (err) { if (active) setError(String(err instanceof Error ? err.message : err)); }
      finally {
        running = false;
        if (active) { setLoading(false); if (queued) { queued = false; void refresh(); } }
      }
    };
    requestRefresh.current = () => { void refresh(); };
    void refresh();
    return () => { active = false; requestRefresh.current = null; };
  }, [projectId, entry.path, open, enabled, pages]);
  useEffect(() => { if (lastRevision.current !== revision) { lastRevision.current = revision; requestRefresh.current?.(); } }, [revision]);

  return <div className="tree-node" data-directory-path={isDirectory ? entry.path : undefined}>
    <button className={`tree-row ${root ? 'tree-root' : ''} ${selected.has(entry.path) || !selected.size && !isDirectory && selectedFile === entry.path ? 'file-selected' : ''}`}
      role="treeitem" aria-expanded={isDirectory ? open : undefined} aria-selected={selected.has(entry.path)}
      aria-level={depth + 1} aria-label={entry.name} title={`${entry.path || entry.name}${decoration ? ` · ${decoration.title}` : ''}`} data-node-path={entry.path} data-node-kind={entry.kind} data-git-tone={decoration ? gitMark(decoration.code).tone : undefined}
      style={{ paddingLeft: 10 + depth * 15 }}
      onClick={event => { if (!choose(entry, event)) { if (isDirectory) onToggle(entry.path); else onSelect(entry.path); } }}
      onContextMenu={event => contextMenu(entry, event)}
      onKeyDown={event => navigateTree(event, open, isDirectory, () => onToggle(entry.path))}>
      <span className="tree-chevron">{isDirectory && (open ? <CaretDown size={12} /> : <CaretRight size={12} />)}</span>
      <FileIcon entry={entry} open={open} />
      <span className="tree-filename">{entry.name}</span>
      {decoration && (isDirectory ? <span className={`git-badge git-${gitMark(decoration.code).tone}`} aria-hidden="true" title={decoration.title}>•</span> : <GitBadge code={decoration.code} />)}
      {loading && !listing && <SpinnerGap size={12} className="loading-spinner" />}
    </button>
    {open && <div role="group" className="tree-children">
      {error ? <div className="tree-error" role="status" style={{ marginLeft: 28 + depth * 15 }}>{error}</div> : <>
        {listing?.entries.map(child => <TreeNode key={child.path} {...props} entry={child} depth={depth + 1} />)}
        {listing && !listing.entries.length && <div className="tree-placeholder" style={{ paddingLeft: 40 + depth * 15 }}>空文件夹</div>}
        {!listing && !loading && <div className="tree-placeholder" style={{ paddingLeft: 40 + depth * 15 }}>正在读取目录…</div>}
        {listing?.nextOffset !== null && listing?.nextOffset !== undefined && <button className="tree-load-more" disabled={loading} onClick={() => setPages(p => p + 1)} style={{ marginLeft: 26 + depth * 15 }}>加载更多（{listing.entries.length} / {listing.total}）</button>}
      </>}
    </div>}
  </div>;
}

export function ProjectExplorer({ project, collapsed, expandedPaths, selectedFile, onCollapse, onExpandedChange, onSelectFile, onReturn, onFilesRemoved, onPathRenamed }: {
  project: Project; collapsed: boolean; expandedPaths: string[]; selectedFile: string | null;
  onCollapse: () => void; onExpandedChange: (paths: string[]) => void; onSelectFile: (path: string) => void;
  onReturn: () => void;
  onFilesRemoved: (paths: string[]) => void; onPathRenamed: (oldPath: string, newPath: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [gitOpen, setGitOpen] = useState(false), [gitRevision, setGitRevision] = useState(0);
  const git = useGitStatus(project.id, !collapsed, revision);
  const decorations = useMemo(() => gitDecorations(git.status), [git.status]);
  const location = project.kind === 'ssh' ? `${project.ssh?.host}:${project.path}` : project.path;
  const expanded = new Set(expandedPaths);
  const files = useExplorerFileActions(project, directory => { setRevision(value => value + 1); if (directory !== undefined) onExpandedChange([...new Set([...expandedPaths, directory])]); }, onSelectFile, onFilesRemoved, onPathRenamed);
  useEffect(() => {
    if (collapsed) return;
    const refresh = () => setRevision(value => value + 1);
    const timer = setInterval(() => { if (document.hasFocus() && document.visibilityState === 'visible') refresh(); }, 3000);
    window.addEventListener('focus', refresh);
    refresh();
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [project.id, collapsed]);
  const toggle = (folder: string) => { const next = new Set(expanded); if (next.has(folder)) next.delete(folder); else next.add(folder); onExpandedChange([...next]); };

  return <aside className={`focus-sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label="项目侧边栏">
    <div className="explorer-navigation">
      <button className="explorer-back" onClick={onReturn} title="返回总览 · Ctrl+Shift+G" aria-label="返回总览"><ArrowLeft size={18} /><span>返回总览</span></button>
      <button className="icon-button sidebar-toggle" onClick={onCollapse} title={collapsed ? '展开目录栏 · Ctrl+B' : '收起目录栏 · Ctrl+B'} aria-label={collapsed ? '展开目录栏' : '收起目录栏'} aria-expanded={!collapsed}><SidebarSimple size={18} /></button>
    </div>
    <div className="explorer-content" hidden={collapsed}>
      {gitOpen ? <button className="explorer-section-toggle" aria-expanded="false" onClick={() => setGitOpen(false)}><CaretRight size={12} />资源管理器</button> : <div className="explorer-toolbar" onPointerDown={() => window.projectGrid.fileTreeFocus(project.id, false)}><div className="explorer-heading"><span>资源管理器</span><span className="explorer-path" title={location}>{location}</span></div><div className="explorer-tools"><button className="icon-button" aria-label="粘贴文件" title="粘贴到选中目录 · Ctrl+V" onClick={files.pasteHere}><Clipboard size={15} /></button><button className="icon-button" aria-label="新建文件" title="新建文件" onClick={() => files.openCreate('file')}><FilePlus size={15} /></button><button className="icon-button" aria-label="新建文件夹" title="新建文件夹" onClick={() => files.openCreate('directory')}><FolderPlus size={15} /></button><button className="icon-button" aria-label="刷新项目目录" title="刷新项目目录" onClick={() => setRevision(r => r + 1)}><ArrowClockwise size={15} /></button><button className="icon-button" aria-label="折叠所有文件夹" title="折叠所有文件夹" onClick={() => onExpandedChange([''])}><ArrowsInLineVertical size={15} /></button></div></div>}
      <div ref={files.tree} className="file-tree" hidden={gitOpen} role="tree" tabIndex={0} aria-multiselectable="true" aria-label={`${project.name} 的文件目录`} onKeyDownCapture={files.onKeyDown} onClick={files.onBackgroundClick} onContextMenu={files.onBackgroundContextMenu}
        onFocusCapture={() => window.projectGrid.fileTreeFocus(project.id, true)} onBlurCapture={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) window.projectGrid.fileTreeFocus(project.id, false); }}>
        <TreeNode projectId={project.id} entry={{ name: project.name, path: '', kind: 'directory' }} depth={0} expanded={expanded} revision={revision} enabled={!collapsed && !gitOpen} selectedFile={selectedFile} onToggle={toggle} onSelect={onSelectFile} selected={files.selected} choose={files.choose} contextMenu={files.contextMenu} decorations={decorations} />
      </div>
      {gitOpen && !collapsed && <GitPanel projectId={project.id} status={git.status} error={git.error} loading={git.loading} revision={gitRevision} onRefresh={() => { git.refresh(); setGitRevision(value => value + 1); }} onOpen={onSelectFile} />}
      {!gitOpen && files.status}
    </div>
    <div className="explorer-actions">
      <button className="explorer-action" onClick={() => { window.projectGrid.fileTreeFocus(project.id, false); setGitOpen(collapsed ? true : !gitOpen); if (collapsed) onCollapse(); }} title="Git 历史与未提交更改" aria-label="Git 历史" aria-pressed={gitOpen && !collapsed}><GitBranch size={18} /><span>Git 历史</span>{!!git.status?.total && <span className="git-action-count">{git.status.total}</span>}</button>
    </div>
    {files.overlays}
  </aside>;
}
