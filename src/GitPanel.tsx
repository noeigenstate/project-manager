import { useEffect, useMemo, useState } from 'react';
import { ArrowClockwise, CaretDown, CaretRight, GitBranch, SpinnerGap } from '@phosphor-icons/react';
import type { GitChange, GitCommit, GitCommitFiles, GitHistory, GitStatus } from './types';
import { commitGraph, gitMark } from './git-status';
import './git.css';

export function GitBadge({ code }: { code: string }) {
  const mark = gitMark(code);
  return <span className={`git-badge git-${mark.tone}`} title={mark.title} aria-hidden="true">{mark.label}</span>;
}
function ChangeGroup({ title, files, staged, onOpen }: { title: string; files: GitChange[]; staged?: boolean; onOpen: (path: string) => void }) {
  const [limit, setLimit] = useState(100);
  if (!files.length) return null;
  return <details className="git-change-group" open><summary>{title}<span>{files.length}</span></summary>
    {files.slice(0, limit).map(file => {
      const code = file.conflict ? 'U' : file.untracked ? '?' : staged ? file.index : file.worktree;
      const mark = gitMark(code), deleted = code === 'D' || !file.conflict && file.worktree === 'D' || file.index + file.worktree === 'DD';
      return <button type="button" className={`git-file git-${mark.tone}`} key={`${file.path}:${file.index}:${file.worktree}`} disabled={deleted}
        title={`${file.path} · ${mark.title}${file.originalPath ? `\n${file.originalPath} → ${file.path}` : ''}`} aria-label={`${mark.title} ${file.path}`} onClick={() => onOpen(file.path)}>
        <span className="git-file-path">{file.path}</span><GitBadge code={code} />
      </button>;
    })}
    {files.length > limit && <button className="tree-load-more" onClick={() => setLimit(value => value + 100)}>加载更多更改（{limit} / {files.length}）</button>}
  </details>;
}
function CommitDetails({ projectId, commit }: { projectId: string; commit: GitCommit }) {
  const [data, setData] = useState<GitCommitFiles | null>(null), [error, setError] = useState('');
  const [limit, setLimit] = useState(100);
  useEffect(() => {
    let active = true;
    window.projectGrid.gitFiles(projectId, commit.hash).then(result => {
      if (!active) return;
      if (result.ok) setData(result.value); else setError(result.error);
    }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [projectId, commit.hash]);
  return <div className="git-commit-detail" aria-label={`提交 ${commit.hash.slice(0, 8)} 的文件`}>
    <div className="git-commit-hash">{commit.hash}</div>
    {commit.parents.length > 1 && <p>合并提交 · 相对第一父提交</p>}
    {error ? <p className="git-error" role="status">{error}</p> : !data ? <p>正在读取文件…</p> : <>
      <p>{data.total} 个已提交文件{data.truncated ? ' · 仅显示前 5000 项' : ''}</p>
      {data.files.slice(0, limit).map((file, index) => <div className={`git-file git-${gitMark(file.status).tone}`} key={`${file.path}:${index}`} title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}><span className="git-file-path">{file.path}</span><GitBadge code={file.status} /></div>)}
      {data.files.length > limit && <button className="tree-load-more" onClick={() => setLimit(value => value + 100)}>加载更多文件</button>}
    </>}
  </div>;
}
function History({ projectId, status, revision }: { projectId: string; status: GitStatus; revision: number }) {
  const [offset, setOffset] = useState(0), [data, setData] = useState<GitHistory | null>(null), [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null), [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true; setLoading(true); setError(''); setSelected(null);
    window.projectGrid.gitHistory(projectId, offset).then(result => {
      if (!active) return;
      if (result.ok) setData(result.value); else { setData(null); setError(result.error); }
    }).catch(error => { if (active) { setData(null); setError(String(error)); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, status.head, status.branch, offset, revision]);
  const graph = useMemo(() => commitGraph(data?.commits || []), [data]);
  return <section className="git-history" aria-label="已提交历史">
    <h3>已提交历史{loading && <SpinnerGap size={13} className="loading-spinner" />}</h3>
    {error ? <p className="git-error" role="status">{error}</p> : !data ? <p className="git-empty">正在读取提交…</p> : !data.commits.length ? <p className="git-empty">{offset ? '没有更多提交' : '还没有提交记录'}</p> :
      data.commits.map((commit, index) => {
        const row = graph.rows[index], open = selected === commit.hash;
        return <div className="git-commit" key={commit.hash}>
          <button className="git-commit-row" aria-expanded={open} aria-label={`查看提交 ${commit.hash.slice(0, 8)} ${commit.subject}`} onClick={() => setSelected(open ? null : commit.hash)}>
            <svg className="git-graph" style={{ width: Math.min(graph.width, 84) }} viewBox={`0 0 ${graph.width} 58`} preserveAspectRatio="none" aria-hidden="true">
              {row.edges.map((edge, at) => <path key={at} d={edge.node ? `M ${edge.from * 12 + 10} 20 C ${edge.from * 12 + 10} 42 ${edge.to * 12 + 10} 42 ${edge.to * 12 + 10} 58` : `M ${edge.from * 12 + 10} 0 C ${edge.from * 12 + 10} 29 ${edge.to * 12 + 10} 29 ${edge.to * 12 + 10} 58`} className={`git-lane-${edge.color}`} />)}
              {row.incoming && <path d={`M ${row.lane * 12 + 10} 0 V 20`} className={`git-lane-${row.color}`} />}
              <circle cx={row.lane * 12 + 10} cy="20" r="4" className={`git-lane-${row.color}`} />
            </svg>
            <span className="git-commit-copy"><strong title={commit.subject}>{commit.subject || '(无提交说明)'}</strong>{commit.refs && <span className="git-refs" title={commit.refs}>{commit.refs}</span>}<small title={`${commit.author} · ${new Date(commit.date).toLocaleString()}`}>{commit.hash.slice(0, 8)} · {commit.author}</small></span>
            {open ? <CaretDown size={11} /> : <CaretRight size={11} />}
          </button>
          {open && <div className="git-commit-expanded" style={{ gridTemplateColumns: `${Math.min(graph.width, 84)}px minmax(0, 1fr)` }}><div className="git-continuation"><svg viewBox={`0 0 ${graph.width} 1`} preserveAspectRatio="none" aria-hidden="true">{row.colors.map((color, index) => <path key={index} d={`M ${index * 12 + 10} 0 V 1`} className={`git-lane-${color}`} vectorEffect="non-scaling-stroke" />)}</svg></div><CommitDetails projectId={projectId} commit={commit} /></div>}
        </div>;
      })}
    <div className="git-history-pages"><button disabled={!offset || loading} onClick={() => setOffset(Math.max(0, offset - 40))}>上一页</button><span>{Math.floor(offset / 40) + 1}</span><button disabled={data?.nextOffset == null || loading} onClick={() => setOffset(data?.nextOffset || 0)}>下一页</button></div>
  </section>;
}
export function GitPanel({ projectId, status, error, loading, revision, onRefresh, onOpen }: {
  projectId: string; status: GitStatus | null; error: string; loading: boolean; revision: number; onRefresh: () => void; onOpen: (path: string) => void;
}) {
  return <div className="git-panel" aria-label="Git 历史与更改">
    <div className="git-toolbar"><span><GitBranch size={16} />源代码管理</span><button className="icon-button" aria-label="刷新 Git 状态和历史" onClick={onRefresh}><ArrowClockwise size={15} className={loading ? 'loading-spinner' : undefined} /></button></div>
    {error ? <p className="git-error" role="status">{error}</p> : !status ? <p className="git-empty">正在读取 Git 状态…</p> : !status.repository ? <p className="git-empty">此项目不是 Git 工作区</p> : <>
      <div className="git-branch" title={status.upstream ? `上游：${status.upstream}` : '未设置上游分支'}><GitBranch size={14} /><strong>{status.detached ? `HEAD ${status.head.slice(0, 8)}` : status.branch}</strong>{status.ahead !== null && <span>↑{status.ahead} ↓{status.behind}</span>}</div>
      <section className="git-working" aria-label="未提交更改"><h3>未提交更改<span>{status.total}</span></h3>
        {!status.total && <p className="git-empty">工作区干净，没有未提交更改</p>}
        {status.truncated && <p className="git-empty">变更较多，仅显示前 5000 项。</p>}
        <ChangeGroup title="合并冲突" files={status.files.filter(file => file.conflict)} onOpen={onOpen} />
        <ChangeGroup title="已暂存" files={status.files.filter(file => !file.conflict && !file.untracked && file.index !== '.')} staged onOpen={onOpen} />
        <ChangeGroup title="工作区更改" files={status.files.filter(file => !file.conflict && (file.untracked || file.worktree !== '.'))} onOpen={onOpen} />
      </section>
      <History key={`${status.branch}:${status.unborn}`} projectId={projectId} status={status} revision={revision} />
    </>}
  </div>;
}
