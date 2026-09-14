import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalPacket } from './types';
import { createTerminalLinkProvider } from './terminal-links';
import '@xterm/xterm/css/xterm.css';

export function TerminalPane({ id, sessionId, fontSize, onError, focused, onOpenLink }: {
  id: string; sessionId: string | null; fontSize: number; focused: boolean; onError: (message: string) => void;
  onOpenLink: (id: string, target: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const report = useRef(onError);
  report.current = onError;
  const openLink = useRef(onOpenLink);
  openLink.current = onOpenLink;

  useEffect(() => {
    if (!host.current || !sessionId) return;
    const activateLink = (event: MouseEvent, target: string) => {
      if (!event.ctrlKey || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      openLink.current(id, target);
    };
    const hoverLink = (_event: MouseEvent, target: string) => { if (host.current) host.current.title = `Ctrl + 鼠标左键打开链接\n${target}`; };
    const leaveLink = () => { if (host.current) host.current.removeAttribute('title'); };
    const terminal = new Terminal({
      fontFamily: "'Cascadia Code', 'Consolas', 'Microsoft YaHei UI', monospace",
      fontSize, lineHeight: 1.22, fontWeight: '400', scrollback: 3000, minimumContrastRatio: 4.5,
      cursorBlink: true, cursorStyle: 'bar', allowProposedApi: false, allowTransparency: true,
      linkHandler: { activate: activateLink, hover: hoverLink, leave: leaveLink, allowNonHttpProtocols: true },
      theme: {
        background: '#00000000', foreground: '#f1f6fc', cursor: '#f1f6fc',
        selectionBackground: '#405770', black: '#252a34', red: '#ff969e',
        green: '#a2ddb8', yellow: '#f2d596', blue: '#a1caff', magenta: '#d0b6f7',
        cyan: '#a0e0e8', white: '#e7eff9', brightBlack: '#b2c2d5', brightRed: '#ffacb2',
        brightGreen: '#a1d8b7', brightYellow: '#f0d297', brightBlue: '#a0caff',
        brightMagenta: '#d0baf2', brightCyan: '#a2e1e7', brightWhite: '#f2f5fa',
        scrollbarSliderBackground: '#46536455', scrollbarSliderHoverBackground: '#64768c88', scrollbarSliderActiveBackground: '#7b8ea599',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host.current);
    // node-pty uses its bundled modern ConPTY, including on Windows 10.
    // 21376 is xterm's capability threshold for VT wrapping and reflow.
    terminal.options.windowsPty = { backend: 'conpty', buildNumber: 21376 };
    const links = terminal.registerLinkProvider(createTerminalLinkProvider(terminal, activateLink, hoverLink, leaveLink));
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
      unsubscribe(); input.dispose(); resized.dispose(); links.dispose(); observer.disconnect(); cancelAnimationFrame(frame);
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
