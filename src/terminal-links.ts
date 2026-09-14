import type { IBuffer, IBufferCellPosition, ILinkProvider, Terminal } from '@xterm/xterm';

type LinkCandidate = { start: number; end: number; target: string };

export function findLinkCandidates(text: string): LinkCandidate[] {
  const links: LinkCandidate[] = [];
  const add = (start: number, end: number, target: string) => {
    if (target.length > 4096 || links.some(link => start < link.end && end > link.start)) return;
    links.push({ start, end, target });
  };
  const looksLikeLink = (value: string) => /^(?:https?:\/\/|file:\/\/|www\.)/i.test(value) || /\.[a-z][a-z\d]{0,15}(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?$/i.test(value);
  for (const match of text.matchAll(/\[[^\]\r\n]+\]\(((?:[^()\r\n]|\([^()\r\n]*\))+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '');
    if (looksLikeLink(target)) add(match.index, match.index + match[0].length, target);
  }
  for (const match of text.matchAll(/(["'`])([^\r\n]+?)\1/g)) {
    if (looksLikeLink(match[2])) add(match.index + 1, match.index + match[0].length - 1, match[2]);
  }
  for (const match of text.matchAll(/(?:https?:\/\/|file:\/\/|www\.)[^\s<>"'`，。；！？]+/gi)) {
    let target = match[0].replace(/[.,;，。；]+$/, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (target.endsWith(close) && target.split(close).length > target.split(open).length) target = target.slice(0, -1);
    }
    add(match.index, match.index + target.length, target);
  }
  const files = /(?:[a-z]:[\\/]|[\\/])?(?:[\p{L}\p{N}_.@~%$+&=()[\]-]+[\\/])*[\p{L}\p{N}_@~%$+&=()[\].-]+\.[a-z][a-z\d]{0,15}(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?/giu;
  for (const match of text.matchAll(files)) add(match.index, match.index + match[0].length, match[0]);
  return links.sort((a, b) => a.start - b.start);
}

// Each UTF-16 index maps to an actual terminal cell, including wide Chinese
// characters, emoji and links wrapped across several screen rows.
export function readLogicalLine(buffer: IBuffer, cols: number, lineNumber: number) {
  let start = lineNumber - 1;
  let end = start;
  while (start > 0 && buffer.getLine(start)?.isWrapped && lineNumber - start < 40) start--;
  while (buffer.getLine(end + 1)?.isWrapped && end - start < 40) end++;
  let text = '';
  const starts: IBufferCellPosition[] = [];
  const ends: IBufferCellPosition[] = [];
  for (let row = start; row <= end; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const length = line.translateToString(row === end).length;
    let rowLength = 0;
    for (let col = 0; col < Math.min(line.length, cols) && rowLength < length; col++) {
      const cell = line.getCell(col);
      if (!cell || cell.getWidth() === 0) continue;
      // A wide glyph can leave one empty padding cell at the wrap boundary.
      if (row < end && col === cols - 1 && !cell.getChars()) continue;
      const chars = cell.getChars() || ' ';
      text += chars;
      rowLength += chars.length;
      for (let i = 0; i < chars.length; i++) {
        starts.push({ x: col + 1, y: row + 1 });
        ends.push({ x: col + Math.max(1, cell.getWidth()), y: row + 1 });
      }
    }
  }
  return { text, starts, ends };
}

export function createTerminalLinkProvider(terminal: Terminal, activate: (event: MouseEvent, target: string) => void, hover: (event: MouseEvent, target: string) => void, leave: () => void): ILinkProvider {
  return { provideLinks(lineNumber, callback) {
    const { text, starts, ends } = readLogicalLine(terminal.buffer.active, terminal.cols, lineNumber);
    callback(findLinkCandidates(text).flatMap(link => {
      const start = starts[link.start];
      const end = ends[link.end - 1];
      return start && end && start.y <= lineNumber && end.y >= lineNumber
        ? [{ text: link.target, range: { start, end }, activate, hover, leave }] : [];
    }));
  } };
}
