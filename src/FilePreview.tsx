import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwise, ArrowSquareOut, CaretLeft, CaretRight, Copy, FileText, FilmStrip, Globe, Image as ImageIcon, MagnifyingGlassMinus, MagnifyingGlassPlus, SpinnerGap, Terminal, X } from '@phosphor-icons/react';
import type { FilePreview as Preview, Result } from './types';

function TextContent({ content }: { content: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 700 });
  const lines = useMemo(() => content.split('\n'), [content]);
  const width = useMemo(() => lines.reduce((max, line) => Math.max(max, Math.min(line.length, 2000)), 0), [lines]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const resize = new ResizeObserver(() => setScroll(value => ({ ...value, height: node.clientHeight })));
    resize.observe(node);
    return () => resize.disconnect();
  }, []);
  const first = Math.max(0, Math.floor((scroll.top - 16) / 22) - 8);
  const last = Math.min(lines.length, first + Math.ceil(scroll.height / 22) + 20);
  return <div className="file-code-scroll" ref={viewport} onScroll={event => { const top = event.currentTarget.scrollTop; setScroll(value => ({ ...value, top })); }}>
    <div className="file-code-page" style={{ height: lines.length * 22 + 44, minWidth: Math.min(width, 2000) * 7.3 + 90 }}>
      <div className="file-code" style={{ top: first * 22 }}><div className="line-numbers" aria-hidden="true">{lines.slice(first, last).map((_, index) => <span key={first + index}>{first + index + 1}</span>)}</div><pre tabIndex={0} aria-label="文件文本内容"><code>{lines.slice(first, last).join('\n') || ' '}</code></pre></div>
    </div>
  </div>;
}

function fileSize(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log2(Math.max(1, bytes)) / 10)));
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
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
  const [videoError, setVideoError] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageInput, setPageInput] = useState('1');
  const key = `${projectId}:${filePath}:${pageIndex}`;
  const preview = loaded?.key === key && loaded.result.ok ? loaded.result.value : null;
  const error = loaded?.key === key && !loaded.result.ok ? loaded.result.error : null;
  const previewId = preview && 'previewId' in preview ? preview.previewId : null;
  const previewUrl = preview && 'url' in preview ? preview.url : null;
  const text = preview?.kind === 'text' || preview?.kind === 'html' ? preview.content : null;
  const textPage = preview?.kind === 'text' || preview?.kind === 'html' ? preview.page : null;
  const showingText = preview?.kind === 'text' || (preview?.kind === 'html' && mode === 'source');

  useEffect(() => { setImageError(false); setVideoError(false); }, [previewUrl]);
  useEffect(() => { if (textPage) setPageInput(String(textPage.index + 1)); }, [textPage?.index]);
  useEffect(() => () => { if (previewId) window.projectGrid.closePreview(previewId).catch(() => {}); }, [previewId]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    window.projectGrid.readFile(projectId, filePath, pageIndex).then(result => {
      if (active) setLoaded({ key, result });
      else if (result.ok && 'previewId' in result.value) window.projectGrid.closePreview(result.value.previewId).catch(() => {});
    }).catch(err => { if (active) setLoaded({ key, result: { ok: false, error: String(err.message || err) } }); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, filePath, key, pageIndex, revision]);
  const openInCode = async () => { const result = await window.projectGrid.openInCode(projectId, filePath); if (!result.ok) onError(result.error); };
  const openVideo = async () => { const result = await window.projectGrid.openVideo(projectId, filePath); if (!result.ok) onError(result.error); };
  const changeZoom = (step: number) => setZoom(value => Math.max(.1, Math.min(4, (value === 'fit' ? 1 : value) + step)));
  const Icon = preview?.kind === 'image' ? ImageIcon : preview?.kind === 'video' ? FilmStrip : preview?.kind === 'html' ? Globe : FileText;

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
  else if (preview?.kind === 'video') body = videoError
    ? <div className="file-preview-message" role="status"><FilmStrip size={28} /><p>当前视频编码无法在应用中播放，或文件尚未生成完整。</p><button className="button secondary small" onClick={openVideo}>用系统播放器打开</button><button className="text-button" onClick={() => setRevision(r => r + 1)}>重新加载视频</button></div>
    : <div className="video-viewport"><video key={preview.url} className="preview-video" src={preview.url} controls preload="metadata" playsInline aria-label="视频预览" onError={() => setVideoError(true)} /></div>;
  else if (text !== null) body = <TextContent key={`${key}:${revision}`} content={text} />;
  else body = <div className="file-preview-message"><FileText size={28} /><p>{preview?.kind === 'unsupported' ? preview.reason : '无法预览此文件。'}</p><button className="button secondary small" onClick={openInCode}><ArrowSquareOut size={14} />在 VS Code 打开</button></div>;

  return <section className="file-preview" aria-label="文件预览">
    <div className="file-tabs"><button className="terminal-tab" onClick={onClose}><Terminal size={15} />返回终端</button><div className="selected-file-tab"><Icon size={15} /><span>{filePath.split('/').at(-1)}</span><button className="icon-button" title="关闭文件预览" aria-label="关闭文件预览" onClick={onClose}><X size={14} /></button></div><span className="preview-readonly">{preview?.kind === 'image' ? '图片预览' : preview?.kind === 'video' ? '视频预览' : preview?.kind === 'html' ? '网页预览' : '只读预览'}</span></div>
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
      {text !== null && <button className="icon-button" title={textPage && textPage.count > 1 ? '复制当前页内容' : '复制文件内容'} aria-label={textPage && textPage.count > 1 ? '复制当前页内容' : '复制文件内容'} onClick={async () => { const result = await window.projectGrid.copy(text); if (!result.ok) onError(result.error); }}><Copy size={16} /></button>}
      <button className="icon-button" title="在 VS Code 打开文件" aria-label="在 VS Code 打开文件" onClick={openInCode}><ArrowSquareOut size={16} /></button>
    </div></div>
    {body}
    {showingText && textPage && textPage.count > 1 && <form className="text-pagination" onSubmit={event => { event.preventDefault(); const value = Number(pageInput); if (Number.isSafeInteger(value)) setPageIndex(Math.max(0, Math.min(textPage.count - 1, value - 1))); }}>
      <span>分段读取 · 本页行号</span><button type="button" className="preview-option" disabled={!textPage.index || loading} onClick={() => setPageIndex(0)}>首页</button>
      <button type="button" className="icon-button" aria-label="上一页" disabled={!textPage.index || loading} onClick={() => setPageIndex(textPage.index - 1)}><CaretLeft size={15} /></button>
      <label>第 <input aria-label="文件页码" type="number" min={1} max={textPage.count} value={pageInput} onChange={event => setPageInput(event.target.value)} /> / {textPage.count} 页</label><button type="submit" className="preview-option" disabled={loading}>跳转</button>
      <button type="button" className="icon-button" aria-label="下一页" disabled={textPage.index === textPage.count - 1 || loading} onClick={() => setPageIndex(textPage.index + 1)}><CaretRight size={15} /></button>
      <button type="button" className="preview-option" disabled={textPage.index === textPage.count - 1 || loading} onClick={() => setPageIndex(textPage.count - 1)}>末页</button>
    </form>}
    <div className="file-preview-footer"><span>{preview ? fileSize(preview.size) : ''}{preview?.kind === 'image' && dimensions.width > 0 ? ` · ${dimensions.width} × ${dimensions.height}` : ''}{showingText && textPage ? ` · ${textPage.encoding.toUpperCase()}` : ''}</span><span>预览文件时，终端任务继续运行</span></div>
  </section>;
}
