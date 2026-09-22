import { useEffect, useRef, useState } from 'react';
import type { GitStatus } from './types';

export function useGitStatus(projectId: string, enabled: boolean, revision: number) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const refreshRef = useRef<((force?: boolean) => void) | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true, running = false, queued = false, forceQueued = false, retryAt = 0;
    const refresh = async (force = false) => {
      if (!active || !force && Date.now() < retryAt) return;
      if (running) { queued = true; forceQueued ||= force; return; }
      running = true; setLoading(true);
      try {
        const result = await window.projectGrid.gitStatus(projectId);
        if (!active) return;
        if (!result.ok) throw new Error(result.error);
        setStatus(result.value); setError(''); retryAt = 0;
      } catch (error) { if (active) { retryAt = Date.now() + 15000; setStatus(null); setError(String(error instanceof Error ? error.message : error)); } }
      finally { running = false; if (active) { setLoading(false); if (queued) { const force = forceQueued; queued = false; forceQueued = false; void refresh(force); } } }
    };
    refreshRef.current = force => { void refresh(force); };
    void refresh();
    return () => { active = false; refreshRef.current = null; };
  }, [projectId, enabled]);
  useEffect(() => { refreshRef.current?.(); }, [revision]);
  return { status, error, loading, refresh: () => refreshRef.current?.(true) };
}
