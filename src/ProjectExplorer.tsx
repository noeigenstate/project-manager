import { useEffect, useState, type KeyboardEvent } from 'react';
import {
  ArrowLeft, ArrowSquareOut, ArrowsInLineVertical, ArrowClockwise, BracketsCurly,
  CaretDown, CaretRight, CheckCircle, File, FileCode, FileText, Folder, FolderOpen,
  GearSix, LinkSimple, SidebarSimple, SpinnerGap, Image as ImageIcon, FilmStrip,
} from '@phosphor-icons/react';
import type { DirectoryListing, FileEntry, Project } from './types';

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
};

function TreeNode(props: NodeProps) {
  const { projectId, entry, depth, expanded, revision, enabled, selectedFile, onToggle, onSelect } = props;
  const isDirectory = entry.kind === 'directory';
  const open = isDirectory && expanded.has(entry.path);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pages, setPages] = useState(1);
  const root = depth === 0;

  useEffect(() => {
    if (!open || !enabled) return;
    let active = true;
    setLoading(true);
    (async () => {
      const entries: FileEntry[] = [];
      let offset: number | null = 0;
      let result: DirectoryListing | null = null;
      for (let page = 0; page < pages && offset !== null; page++) {
        const response = await window.projectGrid.listDirectory(projectId, entry.path, offset);
        if (!active) return;
        if (!response.ok) throw new Error(response.error);
        result = response.value;
        entries.push(...result.entries);
        offset = result.nextOffset;
      }
      if (active && result) { setListing({ ...result, entries }); setError(''); }
    })().catch(err => { if (active) setError(String(err.message || err)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, entry.path, open, enabled, revision, pages]);

  return <div className="tree-node">
    <button className={`tree-row ${root ? 'tree-root' : ''} ${!isDirectory && selectedFile === entry.path ? 'file-selected' : ''}`}
      role="treeitem" aria-expanded={isDirectory ? open : undefined} aria-selected={!isDirectory && selectedFile === entry.path}
      aria-level={depth + 1} aria-label={entry.name} title={entry.path || entry.name} data-node-path={entry.path}
      style={{ paddingLeft: 10 + depth * 15 }}
      onClick={() => isDirectory ? onToggle(entry.path) : onSelect(entry.path)}
      onKeyDown={event => navigateTree(event, open, isDirectory, () => onToggle(entry.path))}>
      <span className="tree-chevron">{isDirectory && (open ? <CaretDown size={12} /> : <CaretRight size={12} />)}</span>
      <FileIcon entry={entry} open={open} />
      <span className="tree-filename">{entry.name}</span>
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

export function ProjectExplorer({ project, collapsed, expandedPaths, selectedFile, onCollapse, onExpandedChange, onSelectFile, onReturn, onDone, onSettings, onOpenCode }: {
  project: Project; collapsed: boolean; expandedPaths: string[]; selectedFile: string | null;
  onCollapse: () => void; onExpandedChange: (paths: string[]) => void; onSelectFile: (path: string) => void;
  onReturn: () => void; onDone: () => void; onSettings: () => void; onOpenCode: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const expanded = new Set(expandedPaths);
  useEffect(() => {
    if (collapsed) return;
    const refresh = () => setRevision(value => value + 1);
    const timer = setInterval(() => { if (document.hasFocus()) refresh(); }, 3000);
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
      <div className="explorer-project"><span className="eyebrow">当前项目</span><h2>{project.name}</h2><p title={project.path}>{project.path}</p>{project.branch && <span className="explorer-branch">{project.branch}</span>}</div>
      <div className="explorer-toolbar"><span>资源管理器</span><div><button className="icon-button" aria-label="刷新项目目录" title="刷新项目目录" onClick={() => setRevision(r => r + 1)}><ArrowClockwise size={15} /></button><button className="icon-button" aria-label="折叠所有文件夹" title="折叠所有文件夹" onClick={() => onExpandedChange([''])}><ArrowsInLineVertical size={15} /></button></div></div>
      <div className="file-tree" role="tree" aria-label={`${project.name} 的文件目录`}>
        <TreeNode projectId={project.id} entry={{ name: project.name, path: '', kind: 'directory' }} depth={0} expanded={expanded} revision={revision} enabled={!collapsed} selectedFile={selectedFile} onToggle={toggle} onSelect={onSelectFile} />
      </div>
    </div>
    <div className="explorer-actions">
      <button className={`explorer-action finish-action ${project.done ? 'project-finished' : ''}`} onClick={onDone} title={project.done ? '继续开发' : '标记开发完成'} aria-label={project.done ? '继续开发' : '标记开发完成'}><CheckCircle size={18} /><span>{project.done ? '继续开发' : '标记开发完成'}</span></button>
      <button className="explorer-action" onClick={onOpenCode} title="在 VS Code 打开" aria-label="在 VS Code 打开"><ArrowSquareOut size={17} /><span>在 VS Code 打开</span></button>
      <button className="explorer-action" onClick={onSettings} title="工作台设置" aria-label="工作台设置"><GearSix size={18} /><span>设置</span></button>
    </div>
  </aside>;
}
