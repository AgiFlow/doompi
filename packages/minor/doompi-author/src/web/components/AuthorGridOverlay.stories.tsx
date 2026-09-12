/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`. The overlay is absolutely positioned and
 * measures its parent, so each variant supplies a sized relative host.
 */
import type { AuthorWorkspaceDocument } from '../stores/authorWorkspaceStore';
import { AuthorGridOverlay } from './AuthorGridOverlay';

const spec: AuthorWorkspaceDocument = {
  path: 'docs/spec.md',
  kind: 'markdown',
  content: '# Gateway retries\n\nThe gateway retries three times before giving up.',
  sourceSha256: 'abc123',
  annotations: [],
  revisions: [],
  saveRequest: 0,
  version: 1,
  savedVersion: 1,
};

const meta = {
  title: 'Author/AuthorGridOverlay',
  component: AuthorGridOverlay,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">visible · A1 to H8</span>
        <div className="relative h-96 w-full max-w-2xl bg-doom-panel p-4 text-sm text-doom-text">
          <p>The gateway retries three times before giving up.</p>
          <AuthorGridOverlay sessionId="s1" document={spec} visible />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">hidden · renders nothing</span>
        <div className="relative h-24 w-full max-w-2xl bg-doom-panel p-4 text-sm text-doom-text">
          <p>The gateway retries three times before giving up.</p>
          <AuthorGridOverlay sessionId="s2" document={spec} visible={false} />
        </div>
      </div>
    </div>
  ),
};
