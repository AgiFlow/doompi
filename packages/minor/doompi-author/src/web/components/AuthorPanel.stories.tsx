/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`. The panel reads the focused document out of
 * the workspace store, so each variant seeds its own session through the
 * store's public mutations rather than faking the state shape.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import type { AuthorDocumentInput } from '../lib/authorViewportTypes';
import { updateAuthorGridGeometry } from '../lib/authorGrid';
import { addAuthorRegion, focusAuthorDocument, putAuthorDocument } from '../stores/authorWorkspaceStore';
import { AuthorPanel } from './AuthorPanel';

const SPEC: AuthorDocumentInput = {
  path: 'docs/spec.md',
  kind: 'markdown',
  content: '# Gateway retries\n\nThe gateway retries three times before giving up.',
  sourceSha256: 'abc123',
};

function seed(sessionId: string, input: AuthorDocumentInput, comments: readonly string[] = []): void {
  const stored = putAuthorDocument(sessionId, input);
  focusAuthorDocument(sessionId, stored.path, stored.version, stored.sourceSha256);
  comments.forEach((comment, index) => {
    addAuthorRegion(sessionId, {
      id: `${sessionId}-r${index + 1}`,
      documentPath: stored.path,
      revision: stored.version,
      sourceSha256: stored.sourceSha256,
      comment,
      quote: 'The gateway retries three times before giving up.',
      anchor: { kind: 'text-range', startOffset: 20, endOffset: 69, startLine: 3, endLine: 3 },
      viewport: { width: 720, height: 480 },
      createdAt: 1_717_000_000_000,
    });
  });
}

seed('panel-idle', SPEC);
seed('panel-drafts', SPEC, ['Say how long the backoff waits.', 'Name the failure mode.']);
seed('panel-video', { path: 'clips/intro.mp4', kind: 'video', sourceSha256: 'def456' });
seed('panel-locked', SPEC, ['Say how long the backoff waits.']);
seed('panel-grid', SPEC);
updateAuthorGridGeometry('panel-grid', {
  documentPath: SPEC.path,
  revision: 1,
  sourceSha256: SPEC.sourceSha256,
  viewport: { width: 720, height: 480, originX: 0, originY: 0 },
});

function props(sessionId: string, statuses: Readonly<Record<string, string>> = {}): WebPluginSlotProps {
  return {
    ...slotPropsFixture({ sessionId, statuses }).props,
    activeMinorModes: ['author'],
    submitCapture: async () => undefined,
  };
}

const meta = {
  title: 'Author/AuthorPanel',
  component: AuthorPanel,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex w-96 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">markdown · no drafts yet</span>
        <AuthorPanel {...props('panel-idle')} />
      </div>

      <div className="flex w-96 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">two drafts ready to submit</span>
        <AuthorPanel {...props('panel-drafts')} />
      </div>

      <div className="flex w-96 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">video · frame reference notice</span>
        <AuthorPanel {...props('panel-video')} />
      </div>

      <div className="flex w-96 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">submission unavailable</span>
        <AuthorPanel {...{ ...props('panel-locked'), submitCapture: undefined }} />
      </div>

      <div className="flex w-96 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">autonomous voice grid active</span>
        <AuthorPanel {...props('panel-grid', { 'doom-voice': 'voice auto: listening' })} />
      </div>
    </div>
  ),
};
