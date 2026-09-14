import { useEffect, useState } from 'react';
import { ArrowClockwise, ArrowSquareOut, Copy, FileText, SpinnerGap, Terminal, X } from '@phosphor-icons/react';
import type { FilePreview as Preview, Result } from './types';

export function FilePreview({ projectId, filePath, onClose, onError }: {
  projectId: string; filePath: string; onClose: () => void; onError: (message: string) => void;
}) {
  const [loaded, setLoaded] = useState<{ key: string; result: Result<Preview> } | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const key = `${projectId}:${filePath}`;
  const preview = loaded?.key === key && loaded.result.ok ? loaded.result.value : null;
  const error = loaded?.key === key && !loaded.result.ok ? loaded.result.error : null;
  useEffect(() => {
    let active = true;
    setLoading(true);
    window.projectGrid.readFile(projectId, filePath).then(result => { if (active) setLoaded({ key, result }); })
      .catch(err => { if (active) setLoaded({ key, result: { ok: false, error: String(err.message || err) } }); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, filePath, key, revision]);
  const openInCode = async () => { const result = await window.projectGrid.openInCode(projectId, filePath); if (!result.ok) onError(result.error); };

  return <section className="file-preview" aria-label="文件预览">
    <div className="file-tabs"><button className="terminal-tab" onClick={onClose}><Terminal size={15} />返回终端</button><div className="selected-file-tab"><FileText size={15} /><span>{filePath.split('/').at(-1)}</span><button className="icon-button" title="关闭文件预览" aria-label="关闭文件预览" onClick={onClose}><X size={14} /></button></div><span className="preview-readonly">只读预览</span></div>
    <div className="file-preview-toolbar"><span title={filePath}>{filePath.split('/').join('  /  ')}</span><div><button className="icon-button" title="刷新文件" aria-label="刷新文件" onClick={() => setRevision(r => r + 1)}><ArrowClockwise size={16} /></button>{preview?.kind === 'text' && <button className="icon-button" title="复制文件内容" aria-label="复制文件内容" onClick={async () => { const result = await window.projectGrid.copy(preview.content); if (!result.ok) onError(result.error); }}><Copy size={16} /></button>}<button className="icon-button" title="在 VS Code 打开文件" aria-label="在 VS Code 打开文件" onClick={openInCode}><ArrowSquareOut size={16} /></button></div></div>
    {loading && !preview ? <div className="file-preview-message"><SpinnerGap size={22} className="loading-spinner" />正在读取文件…</div> : error ? <div className="file-preview-message" role="status"><FileText size={28} /><p>{error}</p><button className="button secondary small" onClick={() => setRevision(r => r + 1)}>重试</button></div> : preview?.kind === 'text' ? <div className="file-code-scroll"><div className="file-code"><div className="line-numbers" aria-hidden="true">{preview.content.split('\n').map((_, index) => <span key={index}>{index + 1}</span>)}</div><pre tabIndex={0} aria-label="文件文本内容"><code>{preview.content || ' '}</code></pre></div></div> : <div className="file-preview-message"><FileText size={28} /><p>{preview?.kind === 'unsupported' ? preview.reason : '无法预览此文件。'}</p><button className="button secondary small" onClick={openInCode}><ArrowSquareOut size={14} />在 VS Code 打开</button></div>}
    <div className="file-preview-footer"><span>{preview ? `${(preview.size / 1024).toFixed(1)} KB` : ''}</span><span>预览文件时，终端任务继续运行</span></div>
  </section>;
}
