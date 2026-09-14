import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalPacket } from './types';
import '@xterm/xterm/css/xterm.css';

export function TerminalPane({ id, sessionId, fontSize, onError, focused }: {
  id: string; sessionId: string | null; fontSize: number; focused: boolean; onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const report = useRef(onError);
  report.current = onError;

  useEffect(() => {
    if (!host.current || !sessionId) return;
    const terminal = new Terminal({
      fontFamily: "'Cascadia Code', 'Consolas', 'Microsoft YaHei UI', monospace",
      fontSize, lineHeight: 1.22, fontWeight: '400', scrollback: 3000,
      cursorBlink: true, cursorStyle: 'bar', allowProposedApi: false, allowTransparency: true,
      theme: {
        background: '#00000000', foreground: '#dae4f1', cursor: '#d8e1ec',
        selectionBackground: '#334052', black: '#252a34', red: '#ed7b83',
        green: '#88c2a0', yellow: '#dfbc7a', blue: '#80b2eb', magenta: '#b8a2df',
        cyan: '#83c9d2', white: '#d4dce7', brightBlack: '#69788f', brightRed: '#ff939a',
        brightGreen: '#a1d8b7', brightYellow: '#f0d297', brightBlue: '#a0caff',
        brightMagenta: '#d0baf2', brightCyan: '#a2e1e7', brightWhite: '#f2f5fa',
        scrollbarSliderBackground: '#46536455', scrollbarSliderHoverBackground: '#64768c88', scrollbarSliderActiveBackground: '#7b8ea599',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host.current);
    term.current = terminal; fit.current = fitAddon;
    let disposed = false;
    let ready = false;
    let lastSeq = 0;
    let queued: TerminalPacket[] = [];
    const apply = (packet: TerminalPacket) => {
      if (packet.sessionId !== sessionId || packet.seq <= lastSeq) return;
      lastSeq = packet.seq;
      terminal.write(packet.data);
    };
    const unsubscribe = window.projectGrid.onTerminalData(packet => {
      if (packet.id !== id || packet.sessionId !== sessionId || disposed) return;
      if (!ready) queued.push(packet); else apply(packet);
    });
    // Subscribe before obtaining the snapshot. Sequence numbers prevent gaps
    // and double output when the terminal is mounted during an active stream.
    window.projectGrid.attachTerminal(id).then(result => {
      if (disposed) return;
      if (!result.ok) { report.current(result.error); return; }
      if (result.value.sessionId === sessionId) {
        terminal.write(result.value.data);
        lastSeq = result.value.seq;
      }
      ready = true;
      for (const packet of queued) apply(packet);
      queued = [];
    }).catch(error => report.current(String(error)));
    const input = terminal.onData(data => window.projectGrid.writeTerminal(id, data));
    const resized = terminal.onResize(({ cols, rows }) => window.projectGrid.resizeTerminal(id, cols, rows));
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
        const selection = terminal.getSelection();
        if (selection) window.projectGrid.copy(selection);
        return false;
      }
      // Preserve Ctrl+C for interrupting a command. xterm handles ordinary paste.
      return true;
    });
    const resize = () => {
      if (!disposed && host.current && host.current.clientWidth > 20 && host.current.clientHeight > 20) {
        try { fitAddon.fit(); } catch { /* A hidden panel will be fitted when shown. */ }
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    const frame = requestAnimationFrame(resize);
    return () => {
      disposed = true; queued = [];
      unsubscribe(); input.dispose(); resized.dispose(); observer.disconnect(); cancelAnimationFrame(frame);
      terminal.dispose(); term.current = null; fit.current = null;
    };
  }, [id, sessionId]);

  useEffect(() => {
    if (term.current) {
      term.current.options.fontSize = fontSize;
      if (host.current?.clientWidth) fit.current?.fit();
    }
  }, [fontSize]);
  useEffect(() => {
    if (focused && sessionId) {
      const frame = requestAnimationFrame(() => { fit.current?.fit(); term.current?.focus(); });
      return () => cancelAnimationFrame(frame);
    }
  }, [focused, sessionId]);
  return <div className="terminal-host" ref={host} aria-label="项目终端" />;
}
