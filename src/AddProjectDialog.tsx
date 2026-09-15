import { useEffect, useRef, useState } from 'react';
import { FolderSimple, Globe, X } from '@phosphor-icons/react';
import type { SSHInfo } from './types';

export function AddProjectDialog({ onClose, onAdded, onError }: { onClose: () => void; onAdded: () => void; onError: (message: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<'local' | 'ssh'>('local');
  const [info, setInfo] = useState<SSHInfo | null>(null);
  const [host, setHost] = useState('');
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    window.projectGrid.getSSHInfo().then(result => { if (result.ok) setInfo(result.value); }).catch(() => {});
  }, []);
  const add = async () => {
    setBusy(true); setError('');
    try {
      const result = kind === 'local' ? await window.projectGrid.addProjects() : await window.projectGrid.addSSHProject({ host, path: folder, name });
      if (!result.ok) { setError(result.error); return; }
      if (typeof result.value === 'string' || result.value.length) { onAdded(); onClose(); }
    } catch (error) { const message = String(error); setError(message); onError(message); }
    finally { setBusy(false); }
  };
  const setRemotePath = (value: string) => {
    if (value.startsWith('vscode-remote://ssh-remote+')) {
      try { const uri = new URL(value); setHost(decodeURIComponent(uri.host.slice('ssh-remote+'.length))); setFolder(decodeURIComponent(uri.pathname)); return; } catch { }
    }
    setFolder(value);
  };
  return <dialog className="settings-dialog project-dialog" ref={dialog} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="dialog-content" onSubmit={event => { event.preventDefault(); void add(); }}>
      <div className="dialog-heading"><h2>添加项目</h2><button type="button" className="icon-button" aria-label="关闭添加项目" onClick={onClose}><X size={18} /></button></div>
      <div className="project-kind-selector">
        <button type="button" aria-pressed={kind === 'local'} onClick={() => { setKind('local'); setError(''); }}><FolderSimple size={22} /><span><b>本地项目</b><small>这台电脑上的文件夹</small></span></button>
        <button type="button" aria-pressed={kind === 'ssh'} onClick={() => { setKind('ssh'); setError(''); }}><Globe size={22} /><span><b>SSH 远程项目</b><small>Linux 服务器上的项目</small></span></button>
      </div>
      {kind === 'local' ? <p className="project-add-note">选择一个或多个目录，每个项目会打开独立终端。</p> : <div className="remote-project-fields">
        <label>SSH 主机<input autoComplete="off" list="ssh-hosts" aria-label="SSH 主机" placeholder="主机别名或 user@hostname" value={host} onChange={event => setHost(event.target.value)} required /></label>
        <datalist id="ssh-hosts">{info?.hosts.map(host => <option value={host} key={host} />)}</datalist>
        <label>远程项目目录<input aria-label="远程项目目录" placeholder="/home/user/project 或 ~/project" value={folder} onChange={event => setRemotePath(event.target.value)} required /></label>
        <label>项目名称 <span>（可选）</span><input aria-label="项目名称" placeholder="默认使用目录名称" value={name} onChange={event => setName(event.target.value)} maxLength={120} /></label>
        <p className="project-add-note">沿用 SSH 配置里的端口、密钥和跳板机。远端需要 Python 3、Bash；Codex 在远端运行。</p>
        {info?.configExists && <p className="ssh-config-path" title={info.configFile}>SSH 配置：{info.configFile}</p>}
      </div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><button type="button" className="text-button" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy}>{busy ? '正在添加…' : kind === 'local' ? '选择本地文件夹' : '连接并添加'}</button></div>
    </form>
  </dialog>;
}
