import { useEffect, useRef, useState } from 'react';

import { StoryFrame } from '../../components/Story.fixture.tsx';
import { QueueSheet } from './QueueSheet.tsx';
import { queuedEntries } from './session.fixture.ts';

const meta = { title: 'Web/Session/QueueSheet', component: QueueSheet, tags: ['style-system'] };
export default meta;

function QueuePreview({ open = true, unlisted = 0 }: { open?: boolean; unlisted?: number }) {
  const root = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState(queuedEntries);
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLButtonElement>('[data-testid="composer-queued"]')?.click();
  }, [open]);
  return (
    <div ref={root}>
      <QueueSheet
        count={entries.length + unlisted}
        entries={entries}
        onClear={() => setEntries([])}
        onDelete={(id) => setEntries((current) => current.filter((entry) => entry.id !== id))}
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
