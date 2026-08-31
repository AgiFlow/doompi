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
import { useState } from 'react';
import type { QueuedEntry } from '../../lib/sessionModel.ts';

export function QueueSheet({
  count,
  entries,
  onClear,
  onDelete,
}: {
  count: number;
  entries: readonly QueuedEntry[];
  onClear: () => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const unlisted = Math.max(0, count - entries.length);
  const label = `${String(count)} queued message${count === 1 ? '' : 's'}`;

  if (count === 0) return null;

  return (
    <>
      <Button
        variant="subtle"
        size="sm"
        data-testid="composer-queued"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="mb-2 h-7 w-full justify-between rounded-md border border-doom-border-soft bg-doom-panel/60 px-2.5 text-[10px] text-doom-dim hover:text-doom-hi"
      >
        <span className="flex min-w-0 items-center gap-2">
          <RefreshIcon className="h-3 w-3 shrink-0 text-doom-cyan" />
          <span className="font-bold text-doom-hi">{label}</span>
          <span className="truncate text-doom-faint">waiting for the current run</span>
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
            <span className="text-[10px] text-doom-faint">{label} waiting</span>
          </DialogHeader>
          <DialogBody className="overflow-y-auto p-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <ol className="flex flex-col gap-1.5">
              {entries.map((entry, index) => (
                <li
                  key={entry.id}
                  data-testid="queue-sheet-item"
                  className="flex min-w-0 gap-3 rounded-md border border-doom-border-soft bg-doom-deep px-3 py-2.5"
                >
                  <span className="pt-0.5 text-[10px] font-bold text-doom-cyan">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-doom-hi">
                      {entry.text}
                    </p>
                    {entry.images && entry.images.length > 0 ? (
                      <p className="mt-1 text-[9px] text-doom-faint">
                        {entry.images.length} image{entry.images.length === 1 ? '' : 's'} attached
                      </p>
                    ) : null}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    data-testid={`queue-delete-${String(index)}`}
                    aria-label={`delete queued message ${String(index + 1)}`}
                    title={
                      unlisted > 0 ? 'Wait for the complete queue before deleting one message' : 'Delete this message'
                    }
                    disabled={unlisted > 0}
                    onClick={() => onDelete(entry.id)}
                    className="h-7 w-7 shrink-0 text-doom-faint hover:text-doom-red"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
              {unlisted > 0 ? (
                <li
                  data-testid="queue-sheet-unlisted"
                  className="rounded-md border border-dashed border-doom-border px-3 py-2.5 text-[11px] text-doom-faint"
                >
                  {unlisted} more queued message{unlisted === 1 ? ' is' : 's are'} waiting in the session. Their text is
                  not available in this browser.
                </li>
              ) : null}
            </ol>
            <Button
              variant="danger"
              size="sm"
              data-testid="queue-clear"
              className="mt-2 w-full"
              onClick={() => {
                onClear();
                setOpen(false);
              }}
            >
              delete all queued messages
            </Button>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
