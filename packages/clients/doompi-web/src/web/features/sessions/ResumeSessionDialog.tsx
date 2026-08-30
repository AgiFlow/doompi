import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  OptionRow,
} from '@agimon-ai/doompi-web-components';
import { useNavigate } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { useEffect, useMemo, useState } from 'react';
import type { PiSessionHistoryItem } from '../../../types/hub.ts';
import { listSessionHistory, resumeSession } from '../../lib/hubApi.ts';
import { sessionsStore, waitForSession } from '../../stores/sessionsStore.ts';

function threadLabel(thread: PiSessionHistoryItem): string {
  return thread.name?.trim() || thread.firstMessage.trim().split('\n', 1)[0] || 'untitled';
}

/** Searchable Pi history for replacing one live card with an earlier thread. */
export function ResumeSessionDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const byId = useStore(sessionsStore, (state) => state.byId);
  const [threads, setThreads] = useState<PiSessionHistoryItem[]>([]);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let stale = false;
    void listSessionHistory(sessionId).then((result) => {
      if (stale) return;
      setLoading(false);
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setThreads(result.sessions);
    });
    return () => {
      stale = true;
    };
  }, [sessionId]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return threads;
    return threads.filter((thread) => `${thread.name ?? ''}\n${thread.firstMessage}`.toLowerCase().includes(needle));
  }, [query, threads]);

  const submit = async (): Promise<void> => {
    if (selectedId === null || busy || byId[selectedId] !== undefined) return;
    setBusy(true);
    setError('');
    const result = await resumeSession(sessionId, selectedId);
    if ('error' in result) {
      setBusy(false);
      setError(result.error);
      return;
    }
    const appeared = await waitForSession(result.sessionId);
    if (!appeared) {
      setBusy(false);
      setError('The thread resumed but has not appeared yet; it will show up in the rail.');
      return;
    }
    onClose();
    await navigate({ to: '/session/$sessionId', params: { sessionId: result.sessionId } });
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent width="md" data-testid={`session-resume-dialog-${sessionId}`} aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>resume Pi thread</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Input
            data-testid="session-history-search"
            value={query}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            placeholder="search thread history"
          />
          <div
            role="listbox"
            aria-label="Pi thread history"
            data-testid="session-history-list"
            className="max-h-80 overflow-y-auto rounded border border-doom-border bg-doom-deep p-1"
          >
            {visible.map((thread) => {
              const running = byId[thread.id] !== undefined;
              return (
                <OptionRow
                  key={thread.id}
                  density="compact"
                  active={selectedId === thread.id}
                  disabled={running || busy}
                  aria-selected={selectedId === thread.id}
                  data-testid={`session-history-${thread.id}`}
                  onClick={() => setSelectedId(thread.id)}
                  className="w-full items-start px-2.5 py-2 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-bold text-doom-hi">{threadLabel(thread)}</span>
                    {thread.name && thread.firstMessage ? (
                      <span className="mt-0.5 line-clamp-2 block text-[10px] text-doom-dim">{thread.firstMessage}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 pl-3 text-[9px] text-doom-faint">
                    {running ? 'running' : `${thread.messageCount} messages`}
                  </span>
                </OptionRow>
              );
            })}
            {!loading && visible.length === 0 ? (
              <p className="px-2.5 py-6 text-center text-[10px] text-doom-faint">
                {query.trim() ? 'no matching threads' : 'no Pi history for this workspace'}
              </p>
            ) : null}
            {loading ? <p className="px-2.5 py-6 text-center text-[10px] text-doom-faint">loading history…</p> : null}
          </div>
          {error ? (
            <p data-testid="session-resume-error" className="text-[10px] text-doom-red">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              cancel
            </Button>
            <Button
              variant="primary"
              data-testid="session-resume-confirm"
              onClick={() => void submit()}
              disabled={selectedId === null || busy || byId[selectedId] !== undefined}
            >
              {busy ? 'resuming…' : 'resume'}
            </Button>
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
