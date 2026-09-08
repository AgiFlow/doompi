/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`. The view groups fragments differently for
 * cell documents (csv/xlsx) than for slide documents, so both appear here.
 */
import type { AuthorDisplayedRegion } from '../lib/authorViewportTypes.ts';
import type { AuthorWorkspaceDocument } from '../stores/authorWorkspaceStore.ts';
import { AuthorStructuredView } from './AuthorStructuredView.tsx';

const base = { annotations: [], revisions: [], saveRequest: 0, version: 1, savedVersion: 1 } as const;

const sheet: AuthorWorkspaceDocument = {
  ...base,
  path: 'data/budget.csv',
  kind: 'csv',
  structuredFormat: 'csv',
  fragments: [
    { id: 'f1', kind: 'cell', text: 'quarter', location: '0,0', readOnly: true },
    { id: 'f2', kind: 'cell', text: 'spend', location: '0,1', readOnly: true },
    { id: 'f3', kind: 'cell', text: 'Q1', location: '1,0' },
    { id: 'f4', kind: 'cell', text: '12400', location: '1,1' },
    { id: 'f5', kind: 'cell', text: 'Q2', location: '2,0' },
    { id: 'f6', kind: 'cell', text: '15900', location: '2,1' },
  ],
};

const slides: AuthorWorkspaceDocument = {
  ...base,
  path: 'deck/launch.pptx',
  kind: 'pptx',
  structuredFormat: 'pptx',
  fragments: [
    { id: 's1', kind: 'slide', text: 'Launch plan', location: 'ppt/slides/slide1.xml' },
    { id: 's2', kind: 'text-run', text: 'Ship the beta in week three.', location: 'ppt/slides/slide2.xml' },
  ],
};

const marked: readonly AuthorDisplayedRegion[] = [
  {
    ordinal: 1,
    region: {
      id: 'r1',
      documentPath: sheet.path,
      revision: 1,
      comment: 'Check this against the ledger.',
      anchor: { kind: 'cell', fragmentId: 'f4', location: '1,1' },
      viewport: { width: 720, height: 480 },
      createdAt: 1_717_000_000_000,
    },
  },
];

const meta = {
  title: 'Author/AuthorStructuredView',
  component: AuthorStructuredView,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">csv · one region marked</span>
        <AuthorStructuredView sessionId="s1" document={sheet} displayedRegions={marked} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">pptx · slide text view</span>
        <AuthorStructuredView sessionId="s1" document={slides} displayedRegions={[]} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no fragments</span>
        <AuthorStructuredView
          sessionId="s1"
          document={{ ...base, path: 'data/empty.csv', kind: 'csv', fragments: [] }}
          displayedRegions={[]}
        />
      </div>
    </div>
  ),
};
