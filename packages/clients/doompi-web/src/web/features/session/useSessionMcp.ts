import type { SessionMcpActivitySnapshot } from '@agimon-ai/doompi-core/sessionMcp';
import { useEffect, useState } from 'react';

import { readSessionMcpActivity } from '../../lib/sessionMcpApi';

const REFRESH_MS = 2000;

export interface SessionMcpViewState {
  snapshot?: SessionMcpActivitySnapshot;
  loading: boolean;
  error?: string;
  before?: number;
  showLatest: () => void;
  loadOlder: () => void;
  refresh: () => void;
}

/** One host request stream feeds both MCP surfaces. Old session responses never cross a route change. */
export function useSessionMcp(workspaceId: string | undefined, sessionId: string | undefined): SessionMcpViewState {
  const key = JSON.stringify([workspaceId, sessionId]);
  const [page, setPage] = useState<{ key: string; before?: number }>({ key });
  const before = page.key === key ? page.before : undefined;
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    before?: number;
    snapshot?: SessionMcpActivitySnapshot;
    error?: string;
  }>();
  useEffect(() => {
    if (workspaceId === undefined || sessionId === undefined) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      const response = await readSessionMcpActivity(workspaceId, sessionId, before);
      if (disposed) return;
      setResult((previous) =>
        'activity' in response
          ? { key, before, snapshot: response.activity }
          : { key, before, snapshot: previous?.key === key ? previous.snapshot : undefined, error: response.error },
      );
      timer = setTimeout(() => {
        if (document.visibilityState === 'hidden') timer = setTimeout(() => void read(), REFRESH_MS);
        else void read();
      }, REFRESH_MS);
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [key, workspaceId, sessionId, before, retry]);
  const current = result?.key === key ? result : undefined;
  return {
    snapshot: current?.snapshot,
    loading: current === undefined || current.before !== before,
    error: current?.error,
    before,
    showLatest: () => setPage({ key }),
    loadOlder: () => {
      if (current?.snapshot?.nextBefore !== undefined) setPage({ key, before: current.snapshot.nextBefore });
    },
    refresh: () => setRetry((value) => value + 1),
  };
}
