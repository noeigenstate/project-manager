import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalPacket } from './types';
import { createTerminalLinkProvider } from './terminal-links';
import '@xterm/xterm/css/xterm.css';

export function TerminalPane({ id, sessionId, fontSize, onError, focused, onOpenLink, remote = false }: {
  id: string; sessionId: string | null; fontSize: number; focused: boolean; onError: (message: string) => void;
  onOpenLink: (id: string, target: string) => void;
  remote?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const report = useRef(onError);
  report.current = onError;
  const openLink = useRef(onOpenLink);
  openLink.current = onOpenLink;
  const copy = async (text: string) => { const result = await window.projectGrid.copy(text); if (!result.ok) report.current(result.error); };
  const paste = async () => {
    const terminal = term.current;
    const result = await window.projectGrid.readClipboard();
    if (!result.ok) { report.current(result.error); return; }
    if (terminal && terminal === term.current && result.value) terminal.paste(result.value);
  };
  const copyAll = () => {
    const terminal = term.current;
    if (!terminal) return;
    const rows: string[] = [];
    for (let index = 0; index < terminal.buffer.active.length; index++) {
      const line = terminal.buffer.active.getLine(index);
      if (!line) continue;
      // Keep spaces at a soft wrap; trimming every visual row changes commands.
      const text = line.translateToString(!terminal.buffer.active.getLine(index + 1)?.isWrapped);
      if (line.isWrapped && rows.length) rows[rows.length - 1] += text;
      else rows.push(text);
    }
    void copy(rows.join('\n').trimEnd());
  };
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setMenu(null); term.current?.focus(); } };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [menu]);

  useEffect(() => {
    if (!host.current || !sessionId) return;
    const activateLink = (event: MouseEvent, target: string) => {
      if (!event.ctrlKey || event.button !== 0) return;
      // xterm activates links on mouseup. Let that event reach its document
      // selection listener so opening a preview cannot leave a drag running.
      event.preventDefault();
      openLink.current(id, target);
    };
    const hoverLink = (_event: MouseEvent, target: string) => { if (host.current) host.current.title = `Ctrl + 鼠标左键打开链接\n${target}`; };
    const leaveLink = () => { if (host.current) host.current.removeAttribute('title'); };
    const terminal = new Terminal({
      fontFamily: "'Cascadia Code', 'Consolas', 'Microsoft YaHei UI', monospace",
      fontSize, lineHeight: 1.22, fontWeight: '400', scrollback: 3000, minimumContrastRatio: 4.5,
      cursorBlink: true, cursorStyle: 'bar', allowProposedApi: false, allowTransparency: true,
      // Bundled ConPTY reflows the prompt on resize; the cursor line must follow
      // that reflow too, or later output can overwrite old prompt characters.
      reflowCursorLine: !remote,
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
    if (!remote) terminal.options.windowsPty = { backend: 'conpty', buildNumber: 21376 };
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
    const offPaste = window.projectGrid.onTerminalPaste(packet => { if (!disposed && packet.id === id && packet.sessionId === sessionId) terminal.paste(packet.text); });
    const selection = terminal.onSelectionChange(() => { if (host.current) host.current.dataset.hasSelection = String(terminal.hasSelection()); });
    const resized = terminal.onResize(({ cols, rows }) => window.projectGrid.resizeTerminal(id, cols, rows));
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true;
      if (!event.isComposing && event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        // xterm's legacy Enter mapping drops Shift. ConPTY needs native key
        // records; Linux TUIs understand the modified Enter CSI-u sequence.
        window.projectGrid.writeTerminal(id, remote ? '\x1b[13;2u' : '\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_');
        return false;
      }
      if (event.ctrlKey && !event.altKey && event.code === 'KeyC' && (event.shiftKey || terminal.hasSelection())) {
        event.preventDefault();
        const selection = terminal.getSelection();
        if (selection) void copy(selection);
        return false;
      }
      if ((event.ctrlKey && !event.altKey && event.code === 'KeyV') || (event.shiftKey && event.code === 'Insert')) {
        event.preventDefault(); void paste(); return false;
      }
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyA') { event.preventDefault(); terminal.selectAll(); return false; }
      // Ctrl+C without a selection still interrupts the command.
      return true;
    });
    const focusIn = () => window.projectGrid.terminalFocus(id, true);
    const focusOut = () => window.projectGrid.terminalFocus(id, false);
    terminal.textarea?.addEventListener('focus', focusIn);
    terminal.textarea?.addEventListener('blur', focusOut);
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
      unsubscribe(); offPaste(); input.dispose(); selection.dispose(); resized.dispose(); links.dispose(); observer.disconnect(); cancelAnimationFrame(frame);
      terminal.textarea?.removeEventListener('focus', focusIn); terminal.textarea?.removeEventListener('blur', focusOut); focusOut();
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
  const action = (callback: () => void) => { callback(); setMenu(null); term.current?.focus(); };
  return <><div className="terminal-host" ref={host} aria-label="项目终端" onContextMenu={event => {
    event.preventDefault();
    setMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 230)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 180)), selection: term.current?.getSelection() || '' });
  }} />{menu && createPortal(<div ref={menuRef} className="dropdown terminal-context-menu" role="menu" aria-label="终端操作" style={{ left: menu.x, top: menu.y }}>
    <button role="menuitem" disabled={!menu.selection} onClick={() => action(() => { void copy(menu.selection); })}>复制<span>Ctrl C</span></button>
    <button role="menuitem" onClick={() => action(copyAll)}>复制全部终端文字</button>
    <button role="menuitem" onClick={() => action(() => term.current?.selectAll())}>全选<span>Ctrl Shift A</span></button>
    <div className="menu-divider" />
    <button role="menuitem" onClick={() => action(() => { void paste(); })}>粘贴<span>Ctrl V</span></button>
  </div>, document.body)}</>;
}
