/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`. The view has exactly two shapes: the
 * markdown preview and the editor, which is where marked ranges show up.
 */
import type { AuthorDisplayedRegion } from '../lib/authorViewportTypes';
import type { AuthorWorkspaceDocument } from '../stores/authorWorkspaceStore';
import { AuthorTextView } from './AuthorTextView';

const CONTENT = [
  '# Gateway retries',
  '',
  'The gateway retries three times before giving up.',
  '',
  '- first attempt is immediate',
  '- the rest back off',
].join('\n');

const spec: AuthorWorkspaceDocument = {
  path: 'docs/spec.md',
  kind: 'markdown',
  content: CONTENT,
  annotations: [],
  revisions: [],
  saveRequest: 0,
  version: 1,
  savedVersion: 1,
};

const marked: readonly AuthorDisplayedRegion[] = [
  {
    ordinal: 1,
    region: {
      id: 'r1',
      documentPath: spec.path,
      revision: 1,
      comment: 'Say how long the backoff waits.',
      anchor: { kind: 'text-range', startOffset: 22, endOffset: 71, startLine: 3, endLine: 3 },
      viewport: { width: 720, height: 480 },
      createdAt: 1_717_000_000_000,
    },
  },
];

const meta = {
  title: 'Author/AuthorTextView',
  component: AuthorTextView,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex h-64 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">markdown preview</span>
        <AuthorTextView sessionId="s1" document={spec} preview displayedRegions={[]} />
      </div>

      <div className="flex h-64 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">editor · one marked range</span>
        <AuthorTextView sessionId="s1" document={spec} preview={false} displayedRegions={marked} />
      </div>

      <div className="flex h-40 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">empty document</span>
        <AuthorTextView
          sessionId="s1"
          document={{ ...spec, path: 'docs/empty.md', content: '' }}
          preview={false}
          displayedRegions={[]}
        />
      </div>
    </div>
  ),
};
