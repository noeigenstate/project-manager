import type { GitChange, GitCommit, GitStatus } from './types';

export function gitMark(code: string) {
  const values: Record<string, [string, string, string]> = {
    M: ['M', '已修改', 'modified'], A: ['A', '已新增', 'added'], '?': ['U', '未跟踪', 'added'],
    D: ['D', '已删除', 'deleted'], R: ['R', '已重命名', 'renamed'], C: ['C', '已复制', 'added'],
    T: ['T', '类型已改变', 'modified'], U: ['!', '存在冲突', 'conflict'],
  };
  const [label, title, tone] = values[code] || ['M', '已修改', 'modified'];
  return { label, title, tone };
}
export function changeCode(file: GitChange) {
  return file.conflict ? 'U' : file.untracked ? '?' : file.worktree !== '.' ? file.worktree : file.index;
}
export type GitDecoration = { code: string; title: string; count: number };
export function gitDecorations(status: GitStatus | null) {
  const result = new Map<string, GitDecoration>();
  const seen = new Set<string>();
  for (const file of status?.files || []) {
    const code = changeCode(file), existing = result.get(file.path);
    result.set(file.path, { code: existing?.code === 'U' ? 'U' : code, count: 1, title: `${gitMark(code).title}${file.index !== '.' && !file.untracked && !file.conflict ? ' · 已暂存' : ''}${file.originalPath ? ` · ${file.originalPath} → ${file.path}` : ''}` });
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    const parts = file.path.split('/'); parts.pop();
    for (let depth = 0; depth <= parts.length; depth++) {
      const directory = parts.slice(0, depth).join('/'), previous = result.get(directory);
      const count = (previous?.count || 0) + 1;
      result.set(directory, { code: code === 'U' || previous?.code === 'U' ? 'U' : 'M', count, title: `${count} 个文件有更改` });
    }
  }
  return result;
}

// Each row connects the real parent OIDs, preserving forks and merges. No
// synthetic sequential edges are added between unrelated commits.
export function commitGraph(commits: GitCommit[]) {
  let lanes: { hash: string; color: number }[] = [], nextColor = 0;
  const rows = commits.map(commit => {
    let lane = lanes.findIndex(item => item.hash === commit.hash);
    const incoming = lane >= 0;
    if (lane < 0) { lane = lanes.length; lanes.push({ hash: commit.hash, color: nextColor++ % 4 }); }
    const before = [...lanes]; lanes.splice(lane, 1);
    for (const [index, parent] of commit.parents.entries()) if (!lanes.some(item => item.hash === parent)) lanes.splice(Math.min(lane + index, lanes.length), 0, { hash: parent, color: index === 0 ? before[lane].color : nextColor++ % 4 });
    const edges = before.flatMap((item, index) => item.hash === commit.hash
      ? commit.parents.map(parent => { const to = lanes.findIndex(item => item.hash === parent); return { from: lane, to, node: true, color: lanes[to].color }; })
      : [{ from: index, to: lanes.findIndex(target => target.hash === item.hash), node: false, color: item.color }]);
    return { lane, incoming, color: before[lane].color, before: before.length, after: lanes.length, colors: lanes.map(item => item.color), edges };
  });
  return { rows, width: Math.max(1, ...rows.map(row => Math.max(row.before, row.after))) * 12 + 10 };
}
