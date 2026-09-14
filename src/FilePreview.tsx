import { useEffect, useState } from 'react';
import { ArrowClockwise, ArrowSquareOut, Copy, FileText, Globe, Image as ImageIcon, MagnifyingGlassMinus, MagnifyingGlassPlus, SpinnerGap, Terminal, X } from '@phosphor-icons/react';
import type { FilePreview as Preview, Result } from './types';

function TextContent({ content }: { content: string }) {
  return <div className="file-code-scroll"><div className="file-code"><div className="line-numbers" aria-hidden="true">{content.split('\n').map((_, index) => <span key={index}>{index + 1}</span>)}</div><pre tabIndex={0} aria-label="文件文本内容"><code>{content || ' '}</code></pre></div></div>;
}

export function FilePreview({ projectId, filePath, onClose, onError }: {
  projectId: string; filePath: string; onClose: () => void; onError: (message: string) => void;
}) {
  const [loaded, setLoaded] = useState<{ key: string; result: Result<Preview> } | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [imageError, setImageError] = useState(false);
  const key = `${projectId}:${filePath}`;
  const preview = loaded?.key === key && loaded.result.ok ? loaded.result.value : null;
  const error = loaded?.key === key && !loaded.result.ok ? loaded.result.error : null;
  const previewId = preview && 'previewId' in preview ? preview.previewId : null;
  const previewUrl = preview && 'url' in preview ? preview.url : null;
  const text = preview?.kind === 'text' || preview?.kind === 'html' ? preview.content : null;

  useEffect(() => { setMode('preview'); setZoom('fit'); setDimensions({ width: 0, height: 0 }); }, [key]);
  useEffect(() => { setImageError(false); }, [previewUrl]);
  useEffect(() => () => { if (previewId) window.projectGrid.closePreview(previewId).catch(() => {}); }, [previewId]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    window.projectGrid.readFile(projectId, filePath).then(result => {
      if (active) setLoaded({ key, result });
      else if (result.ok && 'previewId' in result.value) window.projectGrid.closePreview(result.value.previewId).catch(() => {});
    }).catch(err => { if (active) setLoaded({ key, result: { ok: false, error: String(err.message || err) } }); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, filePath, key, revision]);
  const openInCode = async () => { const result = await window.projectGrid.openInCode(projectId, filePath); if (!result.ok) onError(result.error); };
  const changeZoom = (step: number) => setZoom(value => Math.max(.1, Math.min(4, (value === 'fit' ? 1 : value) + step)));
  const Icon = preview?.kind === 'image' ? ImageIcon : preview?.kind === 'html' ? Globe : FileText;

  let body;
  if (loading && !preview) body = <div className="file-preview-message"><SpinnerGap size={22} className="loading-spinner" />正在读取文件…</div>;
  else if (error) body = <div className="file-preview-message" role="status"><FileText size={28} /><p>{error}</p><button className="button secondary small" onClick={() => setRevision(r => r + 1)}>重试</button></div>;
  else if (preview?.kind === 'image') body = imageError
    ? <div className="file-preview-message" role="status"><ImageIcon size={28} /><p>图片无法显示，请确认文件完整后刷新。</p><button className="button secondary small" onClick={() => setRevision(r => r + 1)}>重新加载图片</button></div>
    : <div className="image-viewport"><div className={`image-canvas ${zoom === 'fit' ? 'image-fit' : 'image-zoomed'}`}>
      <img key={preview.url} className="preview-image" src={preview.url} alt={preview.name} draggable={false}
        style={zoom !== 'fit' && dimensions.width ? { width: dimensions.width * zoom, height: dimensions.height * zoom } : undefined}
        onLoad={event => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => setImageError(true)} />
    </div></div>;
  else if (preview?.kind === 'html' && mode === 'preview') body = <iframe key={preview.url} className="html-preview-frame" title="HTML 页面预览" src={preview.url} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />;
  else if (text !== null) body = <TextContent content={text} />;
  else if (preview?.kind === 'html') body = <div className="file-preview-message"><FileText size={28} /><p>HTML 源码较大，页面仍可正常预览。</p><button className="button secondary small" onClick={openInCode}>在 VS Code 查看源码</button></div>;
  else body = <div className="file-preview-message"><FileText size={28} /><p>{preview?.kind === 'unsupported' ? preview.reason : '无法预览此文件。'}</p><button className="button secondary small" onClick={openInCode}><ArrowSquareOut size={14} />在 VS Code 打开</button></div>;

  return <section className="file-preview" aria-label="文件预览">
    <div className="file-tabs"><button className="terminal-tab" onClick={onClose}><Terminal size={15} />返回终端</button><div className="selected-file-tab"><Icon size={15} /><span>{filePath.split('/').at(-1)}</span><button className="icon-button" title="关闭文件预览" aria-label="关闭文件预览" onClick={onClose}><X size={14} /></button></div><span className="preview-readonly">{preview?.kind === 'image' ? '图片预览' : preview?.kind === 'html' ? '网页预览' : '只读预览'}</span></div>
    <div className="file-preview-toolbar"><span title={filePath}>{filePath.split('/').join('  /  ')}</span><div>
      {preview?.kind === 'image' && <div className="image-controls">
        <button className="preview-option" aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}>适应窗口</button>
        <button className="preview-option" aria-pressed={zoom === 1} onClick={() => setZoom(1)}>原始尺寸</button>
        <button className="icon-button" title="缩小图片" aria-label="缩小图片" onClick={() => changeZoom(-.25)}><MagnifyingGlassMinus size={16} /></button>
        <span className="zoom-label">{zoom === 'fit' ? '自动' : `${Math.round(zoom * 100)}%`}</span>
        <button className="icon-button" title="放大图片" aria-label="放大图片" onClick={() => changeZoom(.25)}><MagnifyingGlassPlus size={16} /></button>
      </div>}
      {preview?.kind === 'html' && <div className="preview-mode"><button className="preview-option" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>页面</button><button className="preview-option" aria-pressed={mode === 'source'} onClick={() => setMode('source')}>源码</button></div>}
      <button className="icon-button" title="刷新文件" aria-label="刷新文件" onClick={() => setRevision(r => r + 1)}><ArrowClockwise size={16} /></button>
      {text !== null && <button className="icon-button" title="复制文件内容" aria-label="复制文件内容" onClick={async () => { const result = await window.projectGrid.copy(text); if (!result.ok) onError(result.error); }}><Copy size={16} /></button>}
      <button className="icon-button" title="在 VS Code 打开文件" aria-label="在 VS Code 打开文件" onClick={openInCode}><ArrowSquareOut size={16} /></button>
    </div></div>
    {body}
    <div className="file-preview-footer"><span>{preview ? `${(preview.size / 1024).toFixed(1)} KB` : ''}{preview?.kind === 'image' && dimensions.width > 0 ? ` · ${dimensions.width} × ${dimensions.height}` : ''}</span><span>预览文件时，终端任务继续运行</span></div>
  </section>;
}
