import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowCounterClockwise, Microphone, Play, Terminal as TerminalIcon, X } from '@phosphor-icons/react';
import { TerminalPane } from './TerminalPane';
import type { Project, ProjectTerminal, Result } from './types';

function label(terminal: ProjectTerminal) {
  if (terminal.error) return '需要检查';
  if (terminal.codexActive) return terminal.codexActivity === 'working' ? '正在处理' : terminal.codexActivity === 'complete' ? '本轮已完成' : terminal.codexActivity === 'interrupted' ? '已中断' : 'Codex 会话中';
  return terminal.status === 'starting' ? '正在启动' : terminal.status === 'shell' ? '终端就绪' : terminal.status === 'exited' ? '已退出' : '尚未启动';
}

export function ProjectTerminals({ project, focused, fontSize, activeId, setActiveId, onAction, onError, onOpenLink, onVoice }: {
  project: Project; focused: boolean; fontSize: number; activeId: string | null; setActiveId: (id: string) => void;
  onAction: <T,>(promise: Promise<Result<T>>) => Promise<T | undefined>;
  onError: (message: string) => void; onOpenLink: (projectId: string, target: string) => void; onVoice: (project: Project) => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const terminals = project.terminals;
  const multiple = terminals.length > 1;
  const columns = Math.min(Math.ceil(Math.sqrt(terminals.length)), width < 600 ? 1 : width < 1150 ? 2 : 3);
  const rows = Math.ceil(terminals.length / columns);
  const selected = terminals.some(item => item.id === activeId) ? activeId : terminals[0]?.id;
  useEffect(() => {
    const node = area.current; if (!node) return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  return <div ref={area} className={`panel-terminal-area terminal-grid ${multiple ? 'has-splits' : ''}`} style={{ '--terminal-columns': columns, '--terminal-rows': rows } as CSSProperties}>
    {terminals.map(terminal => {
      const stopped = terminal.status === 'stopped' || terminal.status === 'exited';
      const name = `${project.name} ${terminal.title}`;
      return <section key={terminal.id} className={`terminal-split ${selected === terminal.id ? 'is-active-terminal' : ''}`} data-terminal-id={terminal.id} aria-label={name} onPointerDownCapture={() => setActiveId(terminal.id)}>
        {multiple && <header className="terminal-split-header"><span>{terminal.title}</span><span className={`split-status ${terminal.codexActivity === 'working' ? 'working' : terminal.codexActivity === 'complete' ? 'complete' : ''}`}>{label(terminal)}</span>
          <button className="icon-button" title="重启此终端" aria-label={`重启 ${name}`} onClick={() => void onAction(window.projectGrid.restartTerminal(terminal.id))}><ArrowCounterClockwise size={13} /></button>
          <button className="icon-button" title="关闭此终端" aria-label={`关闭 ${name}`} onClick={() => void onAction(window.projectGrid.closeTerminal(terminal.id))}><X size={13} /></button>
        </header>}
        <div className="terminal-split-body">
          {terminal.sessionId ? <TerminalPane id={terminal.id} sessionId={terminal.sessionId} fontSize={fontSize} focused={focused && selected === terminal.id} onError={onError} onOpenLink={(_id, target) => onOpenLink(project.id, target)} remote={project.kind === 'ssh'} />
            : <div className="terminal-empty"><TerminalIcon size={28} weight="light" /><p>项目已就位</p><span>启动终端，在这里开始开发</span><button className="button secondary small" onClick={() => void onAction(window.projectGrid.startTerminal(terminal.id))}><Play size={13} weight="fill" />启动终端</button></div>}
        </div>
        {multiple && <footer className="terminal-split-footer"><span>{terminal.error || (project.kind === 'ssh' ? 'SSH' : 'PowerShell')}</span><div>
          <button className="icon-button voice-button" title="语音输入" aria-label={`语音输入 ${name}`} onClick={() => onVoice({ ...project, id: terminal.id, name, sessionId: terminal.sessionId })}><Microphone size={13} /></button>
          {stopped && terminal.sessionId && <button className="text-button" onClick={() => void onAction(window.projectGrid.startTerminal(terminal.id))}>重新启动</button>}
          {!stopped && !terminal.codexActive && terminal.status !== 'starting' && <button className="text-button" disabled={!terminal.shellReady} onClick={() => void onAction(window.projectGrid.launchCodex(terminal.id))}><Play size={12} />启动 Codex</button>}
          {terminal.codexActive && <span className="session-label">CODEX</span>}
        </div></footer>}
      </section>;
    })}
  </div>;
}
