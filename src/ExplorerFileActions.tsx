import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Clipboard, FilePlus, FolderPlus, PencilSimple, Trash, X, SpinnerGap } from '@phosphor-icons/react';
import type { FileEntry, FileProgress, Project, Result } from './types';

type Edit = { kind: 'file' | 'directory' | 'rename'; directory: string; entry?: FileEntry };
const parentOf = (value: string) => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '';

function EditDialog({ edit, save, close }: { edit: Edit; save: (name: string) => Promise<void>; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(edit.entry?.name || '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); input.current?.select(); }, []);
  const title = edit.kind === 'rename' ? '重命名' : edit.kind === 'directory' ? '新建文件夹' : '新建文件';
  return <dialog ref={dialog} className="settings-dialog file-edit-dialog" onCancel={close}><form className="dialog-content" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await save(name); close(); } catch (error) { setError(String((error as Error).message || error)); } finally { setBusy(false); }
  }}><div className="dialog-heading"><h2>{title}</h2><button className="icon-button" type="button" aria-label="关闭文件操作" onClick={close}><X size={18} /></button></div>
    <label className="file-name-label">名称<input ref={input} autoFocus value={name} onChange={event => setName(event.target.value)} required aria-label="文件或文件夹名称" autoComplete="off" /></label>
    <p className="project-add-note" title={edit.directory || '/'}>位置：{edit.directory || '项目根目录'}</p>{error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-footer"><button type="button" className="text-button" onClick={close}>取消</button><button className="button primary" disabled={busy}>{busy ? '处理中…' : edit.kind === 'rename' ? '保存' : '创建'}</button></div>
  </form></dialog>;
}

export function useExplorerFileActions(project: Project, changed: (directory?: string) => void, select: (path: string) => void, removed: (paths: string[]) => void, renamed: (oldPath: string, newPath: string) => void) {
  const tree = useRef<HTMLDivElement>(null), menuElement = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const anchor = useRef<string>('');
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry; targets: string[] } | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState<FileProgress>(null);
  useEffect(() => {
    const off = window.projectGrid.onFileProgress(setProgress);
    window.projectGrid.getFileProgress().then(result => { if (result.ok) setProgress(result.value); });
    return () => { off(); window.projectGrid.fileTreeFocus(project.id, false); };
  }, [project.id]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!menuElement.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setMenu(null); tree.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape, true); };
  }, [menu]);
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 5000); return () => clearTimeout(timer); }, [message]);
  const unwrap = async <T,>(promise: Promise<Result<T>>) => { const result = await promise; if (!result.ok) throw new Error(result.error); return result.value; };
  const run = async (operation: () => Promise<void>) => { setMenu(null); setMessage(''); try { await operation(); } catch (error) { setMessage(String((error as Error).message || error)); } finally { changed(); } };
  const rows = () => [...(tree.current?.querySelectorAll<HTMLElement>('[data-node-path]') || [])];
  const entryFor = (path: string): FileEntry => {
    const row = rows().find(row => row.dataset.nodePath === path);
    return { path, name: row?.getAttribute('aria-label') || path.split('/').at(-1) || project.name, kind: (row?.dataset.nodeKind || 'file') as FileEntry['kind'] };
  };
  const focused = () => {
    const row = document.activeElement?.closest<HTMLElement>('[data-node-path]');
    return entryFor(row && tree.current?.contains(row) ? row.dataset.nodePath! : selected[0] || '');
  };
  const folder = (entry: FileEntry) => entry.kind === 'directory' || !entry.path ? entry.path : parentOf(entry.path);
  const targets = (entry: FileEntry) => selected.includes(entry.path) ? selected : [entry.path];
  const copy = (paths: string[]) => run(async () => { const result = await unwrap(window.projectGrid.copyEntries(project.id, paths)); if (!result.superseded) setMessage(`已复制 ${result.count} 项，可粘贴到其他位置`); });
  const copyPaths = async (paths: string[], format: 'absolute' | 'relative') => {
    setMenu(null); setMessage('');
    try { const result = await unwrap(window.projectGrid.copyPaths(project.id, paths, format)); if (!result.superseded) setMessage(format === 'absolute' ? '已复制绝对路径' : '已复制相对路径'); }
    catch (error) { setMessage(String((error as Error).message || error)); }
  };
  const paste = (directory: string) => run(async () => {
    const result = await unwrap(window.projectGrid.pasteEntries(project.id, directory));
    setSelected(result.pasted); anchor.current = result.pasted[0] || directory;
    changed(directory); setMessage(`已粘贴 ${result.pasted.length} 项到${directory || '项目根目录'}`);
  });
  const remove = (paths: string[]) => run(async () => { const result = await unwrap(window.projectGrid.deleteEntries(project.id, paths)); removed(result.deleted); setSelected([]); });
  const choose = (entry: FileEntry, event: MouseEvent) => {
    if (event.shiftKey) {
      const paths = rows().map(row => row.dataset.nodePath!); const from = paths.indexOf(anchor.current), to = paths.indexOf(entry.path);
      setSelected(from < 0 || to < 0 ? [entry.path] : paths.slice(Math.min(from, to), Math.max(from, to) + 1)); return true;
    }
    if (event.ctrlKey || event.metaKey) { setSelected(values => values.includes(entry.path) ? values.filter(path => path !== entry.path) : [...values, entry.path]); anchor.current = entry.path; return true; }
    setSelected([entry.path]); anchor.current = entry.path; return false;
  };
  const contextMenu = (entry: FileEntry, event: MouseEvent) => {
    event.preventDefault(); event.stopPropagation();
    const paths = targets(entry); if (!selected.includes(entry.path)) setSelected(paths);
    window.projectGrid.fileTreeFocus(project.id, true);
    setMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 250)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 365)), entry, targets: paths });
  };
  const backgroundEntry = (event: MouseEvent) => entryFor((event.target as Element).closest<HTMLElement>('[data-directory-path]')?.dataset.directoryPath || '');
  const onBackgroundClick = (event: MouseEvent) => {
    if ((event.target as Element).closest('button')) return;
    const entry = backgroundEntry(event);
    setSelected([entry.path]); anchor.current = entry.path; tree.current?.focus();
  };
  const onBackgroundContextMenu = (event: MouseEvent) => { contextMenu(backgroundEntry(event), event); tree.current?.focus(); };
  const onKeyDown = (event: KeyboardEvent) => {
    const entry = menu?.entry || focused(); const control = event.ctrlKey || event.metaKey;
    if (control && event.shiftKey && event.key.toLowerCase() === 'c') { event.preventDefault(); event.stopPropagation(); void copyPaths(targets(entry), 'absolute'); }
    else if (control && (event.key.toLowerCase() === 'c' || event.key === 'Insert')) { event.preventDefault(); event.stopPropagation(); const text = window.getSelection()?.toString(); if (text) void window.projectGrid.copy(text); else void copy(targets(entry)); }
    else if ((control && event.key.toLowerCase() === 'v') || (event.shiftKey && event.key === 'Insert')) { event.preventDefault(); event.stopPropagation(); void paste(folder(entry)); }
    else if (control && event.key.toLowerCase() === 'a') { event.preventDefault(); event.stopPropagation(); setSelected(rows().map(row => row.dataset.nodePath!).filter(Boolean)); }
    else if (event.key === 'Delete' && entry.path) { event.preventDefault(); event.stopPropagation(); void remove(targets(entry)); }
    else if (event.key === 'F2' && entry.path) { event.preventDefault(); event.stopPropagation(); setEdit({ kind: 'rename', directory: parentOf(entry.path), entry }); }
    else if (event.key === 'Escape') setMenu(null);
  };
  const openCreate = (kind: 'file' | 'directory', entry = focused()) => { setMenu(null); setEdit({ kind, directory: folder(entry) }); };
  const save = async (name: string) => {
    if (!edit) return;
    if (edit.kind === 'rename') { const result = await unwrap(window.projectGrid.renameEntry(project.id, edit.entry!.path, name)); renamed(edit.entry!.path, result.path); setSelected([result.path]); anchor.current = result.path; }
    else { const result = await unwrap(window.projectGrid.createEntry(project.id, edit.directory, name, edit.kind)); setSelected([result.path]); anchor.current = result.path; if (edit.kind === 'file') select(result.path); }
    changed(edit.directory);
  };
  const overlays = <>{menu && createPortal(<div ref={menuElement} className="dropdown explorer-context-menu" role="menu" aria-label="文件操作" style={{ left: menu.x, top: menu.y }}>
    <button role="menuitem" onClick={() => void copy(menu.targets)}><Copy size={16} />复制<span>Ctrl C</span></button>
    <button role="menuitem" onClick={() => void copyPaths(menu.targets, 'absolute')}><Copy size={16} />复制绝对路径<span>Ctrl Shift C</span></button>
    <button role="menuitem" onClick={() => void copyPaths(menu.targets, 'relative')}><Copy size={16} />复制相对路径</button>
    <button role="menuitem" onClick={() => void paste(folder(menu.entry))}><Clipboard size={16} />粘贴<span>Ctrl V</span></button><div className="menu-divider" />
    <button role="menuitem" onClick={() => openCreate('file', menu.entry)}><FilePlus size={16} />新建文件</button>
    <button role="menuitem" onClick={() => openCreate('directory', menu.entry)}><FolderPlus size={16} />新建文件夹</button>
    <button role="menuitem" disabled={!menu.entry.path || menu.targets.length !== 1} onClick={() => { setEdit({ kind: 'rename', directory: parentOf(menu.entry.path), entry: menu.entry }); setMenu(null); }}><PencilSimple size={16} />重命名<span>F2</span></button><div className="menu-divider" />
    <button role="menuitem" className="danger-text" disabled={menu.targets.includes('')} onClick={() => void remove(menu.targets)}><Trash size={16} />删除<span>Delete</span></button>
  </div>, document.body)}{edit && <EditDialog edit={edit} save={save} close={() => setEdit(null)} />}</>;
  const status = progress?.projectId === project.id ? <div className="explorer-file-status" role="status"><SpinnerGap className="loading-spinner" size={14} /><span>{progress.text}</span><button className="icon-button" aria-label="取消文件操作" onClick={() => void window.projectGrid.cancelFileOperation()}><X size={13} /></button></div>
    : message ? <div className="explorer-file-status" role="status">{message}</div> : null;
  return { tree, selected: new Set(selected), choose, contextMenu, onKeyDown, openCreate, onBackgroundClick, onBackgroundContextMenu, pasteHere: () => void paste(folder(focused())), overlays, status };
}
