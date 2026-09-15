import { useEffect, useRef, useState } from 'react';
import { LockKey, X } from '@phosphor-icons/react';
import type { SSHAuthPrompt } from './types';

export function SSHAuthDialog({ request }: { request: SSHAuthPrompt }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  const answer = async (response: string | null) => {
    setBusy(true);
    try { const result = await window.projectGrid.answerSSHAuth(request.id, response); if (!result.ok) { setError(result.error); setBusy(false); } }
    catch (error) { setError(String(error)); setBusy(false); }
    setValue('');
  };
  return <dialog className="settings-dialog ssh-auth-dialog" ref={dialog} onCancel={event => { event.preventDefault(); void answer(null); }}>
    <form className="dialog-content" onSubmit={event => { event.preventDefault(); void answer(request.kind === 'confirm' ? 'yes' : value); }}>
      <div className="dialog-heading"><h2><LockKey size={21} />SSH 认证</h2><button className="icon-button" type="button" aria-label="取消 SSH 认证" disabled={busy} onClick={() => void answer(null)}><X size={18} /></button></div>
      <p className="ssh-auth-host">{request.host}</p>
      <p className="ssh-auth-message">{request.message}</p>
      {request.kind === 'secret' && <input autoFocus className="ssh-secret-input" type="password" autoComplete="off" aria-label="SSH 密码或口令" value={value} onChange={event => setValue(event.target.value)} />}
      <p className="project-add-note">{request.kind === 'confirm' ? '确认主机指纹后再信任此服务器。' : '仅用于本次 SSH 认证，不会保存到项目配置。'}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><button type="button" className="text-button" disabled={busy} onClick={() => void answer(null)}>取消连接</button><button className="button primary" disabled={busy}>{busy ? '正在认证…' : request.kind === 'confirm' ? '信任并连接' : '继续连接'}</button></div>
    </form>
  </dialog>;
}
