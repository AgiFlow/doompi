/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`. The drafts panel renders nothing without a
 * candidate or a draft, so every variant carries one of the two.
 */
import type { AuthorRegionDraft } from '../lib/authorViewportTypes';
import type { AuthorSessionWorkspace } from '../stores/authorWorkspaceStore';
import { AuthorRegionDrafts } from './AuthorRegionDrafts';

const draft = (id: string, comment: string): AuthorRegionDraft => ({
  id,
  documentPath: 'docs/spec.md',
  revision: 3,
  comment,
  quote: 'The gateway retries three times before giving up.',
  anchor: { kind: 'text-range', startOffset: 120, endOffset: 190, startLine: 12, endLine: 14 },
  viewport: { width: 720, height: 480 },
  createdAt: 1_717_000_000_000,
});

const videoDraft: AuthorRegionDraft = {
  id: 'r-video',
  documentPath: 'clips/intro.mp4',
  revision: 1,
  comment: 'Cut the pause before the logo.',
  anchor: {
    kind: 'video-time-rect',
    timeSeconds: 12.5,
    rect: { x: 0.1, y: 0.1, width: 0.4, height: 0.3 },
  },
  viewport: { width: 720, height: 480 },
  createdAt: 1_717_000_000_000,
};

const workspace = (overrides: Partial<AuthorSessionWorkspace>): AuthorSessionWorkspace => ({
  generation: 1,
  activeTool: 'mark',
  regions: [],
  requests: [],
  ...overrides,
});

const meta = {
  title: 'Author/AuthorRegionDrafts',
  component: AuthorRegionDrafts,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex w-96 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">text selection pending a comment</span>
        <AuthorRegionDrafts
          sessionId="s1"
          workspace={workspace({
            candidate: {
              documentPath: 'docs/spec.md',
              revision: 3,
              quote: 'The gateway retries three times before giving up.',
              anchor: { kind: 'text-range', startOffset: 120, endOffset: 190, startLine: 12, endLine: 14 },
              viewport: { width: 720, height: 480 },
              createdAt: 1_717_000_000_000,
            },
          })}
        />
      </div>

      <div className="flex w-96 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">video frame selection</span>
        <AuthorRegionDrafts
          sessionId="s1"
          workspace={workspace({
            candidate: {
              documentPath: 'clips/intro.mp4',
              revision: 1,
              anchor: videoDraft.anchor,
              viewport: { width: 720, height: 480 },
              createdAt: 1_717_000_000_000,
            },
          })}
        />
      </div>

      <div className="flex w-96 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">unsent drafts only</span>
        <AuthorRegionDrafts
          sessionId="s1"
          workspace={workspace({
            regions: [draft('r1', 'Say how long the backoff waits.'), videoDraft],
          })}
        />
      </div>
    </div>
  ),
};
