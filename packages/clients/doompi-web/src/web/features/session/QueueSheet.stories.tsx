import { useEffect, useRef, useState } from 'react';

import { StoryFrame } from '../../components/Story.fixture.tsx';
import type { QueuedEntry } from '../../lib/sessionModel.ts';
import { QueueSheet } from './QueueSheet.tsx';
import { queuedEntries } from './session.fixture.ts';

const meta = { title: 'Web/Session/QueueSheet', component: QueueSheet, tags: ['style-system'] };
export default meta;

function QueuePreview({
  open = true,
  unlisted = 0,
  active = false,
  paused = false,
  outcome,
  protectedRow = false,
}: {
  open?: boolean;
  unlisted?: number;
  active?: boolean;
  paused?: boolean;
  outcome?: 'pending' | 'error';
  protectedRow?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [extraCount, setExtraCount] = useState(unlisted);
  const [queuePaused, setQueuePaused] = useState(paused);
  const [entries, setEntries] = useState<QueuedEntry[]>(() => [
    ...queuedEntries.map((entry) => ({ ...entry, disposition: 'pending' as const })),
    ...(protectedRow
      ? [
          {
            kind: 'queued' as const,
            id: 'protected',
            text: 'Check delivery confirmation before retrying.',
            disposition: 'uncertain' as const,
          },
        ]
      : []),
  ]);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[data-testid="composer-queued"]')?.click();
    if (outcome)
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-testid="queue-clear"]')?.click());
  }, [open, outcome]);
  return (
    <div ref={root}>
      <QueueSheet
        count={entries.length + extraCount}
        entries={entries}
        operationId={active ? 'story-run' : undefined}
        paused={queuePaused}
        onClear={async () => {
          if (outcome === 'error')
            throw new Error(
              'Delivery uncertain: the session connection was replaced. Check the queue before retrying.',
            );
          if (outcome === 'pending') await new Promise<void>(() => undefined);
          setEntries((current) => current.filter((entry) => entry.disposition === 'uncertain'));
          setExtraCount(0);
        }}
        onDelete={async (id) => setEntries((current) => current.filter((entry) => entry.id !== id))}
        onPromote={async (id) => setEntries((current) => current.filter((entry) => entry.id !== id))}
        onResume={async () => setQueuePaused(false)}
      />
    </div>
  );
}
export const Playground = {
  render: () => (
    <StoryFrame>
      <QueuePreview />
    </StoryFrame>
  ),
};
export const Collapsed = {
  render: () => (
    <StoryFrame>
      <QueuePreview open={false} />
    </StoryFrame>
  ),
};
export const PartialQueue = {
  render: () => (
    <StoryFrame>
      <QueuePreview unlisted={2} />
    </StoryFrame>
  ),
};
export const Active = {
  render: () => (
    <StoryFrame>
      <QueuePreview active />
    </StoryFrame>
  ),
};
export const Paused = {
  render: () => (
    <StoryFrame>
      <QueuePreview paused />
    </StoryFrame>
  ),
};
export const Pending = {
  render: () => (
    <StoryFrame>
      <QueuePreview outcome="pending" />
    </StoryFrame>
  ),
};
export const DeliveryError = {
  render: () => (
    <StoryFrame>
      <QueuePreview outcome="error" protectedRow />
    </StoryFrame>
  ),
};
