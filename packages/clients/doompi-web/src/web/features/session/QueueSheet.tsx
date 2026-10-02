import {
  Button,
  ChevronUpIcon,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  RefreshIcon,
  TrashIcon,
} from '@agimon-ai/doompi-web-components';
import { useRef, useState } from 'react';

import type { QueuedEntry } from '../../lib/sessionModel';

export function QueueSheet({
  count,
  disabled = false,
  entries,
  onClear,
  onDelete,
  onPromote,
  onResume,
  operationId,
  paused = false,
}: {
  count: number;
  disabled?: boolean;
  entries: readonly QueuedEntry[];
  onClear: () => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onPromote?: (id: string, operationId?: string) => Promise<void>;
  onResume?: () => Promise<void>;
  operationId?: string;
  paused?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const pendingAction = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearAcknowledged, setClearAcknowledged] = useState(false);
  const unlisted = Math.max(0, count - entries.length);
  const label = `${String(count)} queued message${count === 1 ? '' : 's'}`;

  // The acknowledgement can precede its lifecycle update. Only both confirm emptiness.
  if (clearAcknowledged && count === 0) {
    setClearAcknowledged(false);
    setOpen(false);
  }

  const act = async (action: string, command: () => Promise<void>): Promise<void> => {
    if (disabled || pendingAction.current !== null) return;
    pendingAction.current = action;
    setPending(action);
    setError(null);
    setClearAcknowledged(false);
    try {
      await command();
      if (action === 'clear') setClearAcknowledged(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pendingAction.current = null;
      setPending(null);
    }
  };
  const actionDisabled = disabled || pending !== null;

  if (count === 0 && !paused && !open) return null;

  return (
    <>
      <Button
        variant="subtle"
        size="sm"
        data-testid="composer-queued"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="mb-2 h-7 w-full justify-between rounded-md border border-doom-border-soft bg-doom-panel/60 px-2.5 text-xs text-doom-dim hover:text-doom-hi"
      >
        <span className="flex min-w-0 items-center gap-2">
          <RefreshIcon className="h-3 w-3 shrink-0 text-doom-cyan" />
          <span className="font-bold text-doom-hi">{label}</span>
          <span className="truncate text-doom-faint">
            {paused ? 'paused until resumed' : 'waiting for the current run'}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-doom-faint">
          view queue
          <ChevronUpIcon className="h-3 w-3" />
        </span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          width="lg"
          data-testid="queue-sheet"
          aria-describedby={undefined}
          className="top-auto bottom-0 left-1/2 max-h-[min(72dvh,560px)] !w-full !max-w-2xl -translate-x-1/2 translate-y-0 rounded-t-xl rounded-b-none border-b-0 data-[state=open]:animate-none"
        >
          <span aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-doom-border" />
          <DialogHeader dismissible closeLabel="close queued messages" className="py-2.5">
            <DialogTitle>queued messages</DialogTitle>
            <span className="text-xs text-doom-faint">{paused ? 'paused' : `${label} waiting`}</span>
          </DialogHeader>
          <DialogBody className="overflow-y-auto p-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <ol className="flex flex-col gap-1.5">
              {entries.map((entry, index) => (
                <li
                  key={entry.id}
                  data-testid="queue-sheet-item"
                  className="flex min-w-0 gap-3 rounded-md border border-doom-border-soft bg-doom-deep px-3 py-2.5"
                >
                  <span className="pt-0.5 text-xs font-bold text-doom-cyan">{String(index + 1).padStart(2, '0')}</span>
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-doom-hi">{entry.text}</p>
                    {entry.images && entry.images.length > 0 ? (
                      <p className="mt-1 text-2xs text-doom-faint">
                        {entry.images.length} image{entry.images.length === 1 ? '' : 's'} attached
                      </p>
                    ) : null}
                    {entry.disposition === 'uncertain' ? (
                      <p className="mt-1 text-2xs text-doom-red">delivery uncertain; not resending automatically</p>
                    ) : null}
                  </div>
                  {entry.disposition === 'pending' && onPromote ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`queue-steer-${String(index)}`}
                      aria-label={`${operationId === undefined ? 'send' : 'interrupt and respond to'} queued message ${String(index + 1)}`}
                      disabled={actionDisabled}
                      onClick={() => void act(`send:${entry.id}`, () => onPromote(entry.id, operationId))}
                      className="h-7 shrink-0 text-doom-cyan"
                    >
                      {pending === `send:${entry.id}`
                        ? 'sending…'
                        : operationId === undefined
                          ? 'send now'
                          : 'interrupt and respond'}
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    data-testid={`queue-delete-${String(index)}`}
                    aria-label={`delete queued message ${String(index + 1)}`}
                    title={
                      entry.disposition === 'uncertain'
                        ? 'Delivery is uncertain; refresh the session first'
                        : entry.disposition === 'handoff'
                          ? 'This message is already being delivered'
                          : 'Delete this message'
                    }
                    disabled={actionDisabled || entry.disposition !== 'pending'}
                    onClick={() => void act(`delete:${entry.id}`, () => onDelete(entry.id))}
                    className="h-7 w-7 shrink-0 text-doom-faint hover:text-doom-red"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
              {unlisted > 0 ? (
                <li
                  data-testid="queue-sheet-unlisted"
                  className="rounded-md border border-dashed border-doom-border px-3 py-2.5 text-sm text-doom-faint"
                >
                  {unlisted} more queued message{unlisted === 1 ? ' is' : 's are'} waiting in the session. Their text is
                  not available in this browser.
                </li>
              ) : null}
            </ol>
            {paused && onResume ? (
              <Button
                variant="subtle"
                size="sm"
                data-testid="queue-resume"
                className="mt-2 w-full"
                disabled={actionDisabled}
                onClick={() => void act('resume', onResume)}
              >
                {pending === 'resume' ? 'resuming…' : 'resume queued messages'}
              </Button>
            ) : null}
            {count > 0 ? (
              <Button
                variant="danger"
                size="sm"
                data-testid="queue-clear"
                className="mt-2 w-full"
                disabled={actionDisabled}
                onClick={() => void act('clear', onClear)}
              >
                {pending === 'clear' ? 'deleting…' : 'delete all queued messages'}
              </Button>
            ) : null}
            {pending !== null ? (
              <p role="status" className="mt-2 text-xs text-doom-faint">
                waiting for the session to acknowledge this action…
              </p>
            ) : null}
            {error !== null ? (
              <p role="alert" data-testid="queue-error" className="mt-2 text-xs text-doom-red">
                {error}
              </p>
            ) : clearAcknowledged && count > 0 ? (
              <p role="status" data-testid="queue-clear-remaining" className="mt-2 text-xs text-doom-faint">
                Messages remain or await confirmation. Messages being delivered or with uncertain delivery cannot be
                cleared.
              </p>
            ) : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
