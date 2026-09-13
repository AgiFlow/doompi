/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`. The log takes the request history straight
 * as a prop, so the states here are the request statuses it styles.
 */
import type { AuthorRegionDraft, AuthorRequestRecord } from '../lib/authorViewportTypes';
import { AuthorRequestLog } from './AuthorRequestLog';

const region = (id: string, comment: string, startLine: number, endLine: number): AuthorRegionDraft => ({
  id,
  documentPath: 'docs/spec.md',
  revision: 3,
  comment,
  quote: 'The gateway retries three times before giving up.',
  anchor: { kind: 'text-range', startOffset: 120, endOffset: 190, startLine, endLine },
  viewport: { width: 720, height: 480 },
  createdAt: 1_717_000_000_000,
});

const request = (overrides: Partial<AuthorRequestRecord>): AuthorRequestRecord => ({
  id: 'req-1',
  documentPath: 'docs/spec.md',
  requestText:
    'Please address the attached feedback. Request ID: req-1 Tighten the retry wording and name the backoff.',
  regions: [region('r1', 'Say how long the backoff waits.', 12, 14)],
  status: 'REQUESTED',
  createdAt: 1_717_000_000_000,
  updatedAt: 1_717_000_000_000,
  revision: 3,
  ...overrides,
});

const working = request({
  id: 'req-2',
  status: 'CHANGING',
  currentOperation: 'Rewriting the retry paragraph',
  regions: [region('r1', 'Say how long the backoff waits.', 12, 14), region('r2', 'Drop the duplicate note.', 30, 30)],
  pendingRegions: [region('r2', 'Drop the duplicate note.', 30, 30)],
  before: 'The gateway retries three times before giving up.',
  after: 'The gateway retries three times, backing off 2s between attempts.',
});

const meta = {
  title: 'Author/AuthorRequestLog',
  component: AuthorRequestLog,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex w-96 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">empty</span>
        <AuthorRequestLog requests={[]} />
      </div>

      <div className="flex w-96 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">queued</span>
        <AuthorRequestLog requests={[request({})]} />
      </div>

      <div className="flex w-96 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          working · with earlier requests collapsed
        </span>
        <AuthorRequestLog
          requests={[
            request({ id: 'req-0', status: 'COMPLETE', currentOperation: '' }),
            request({ id: 'req-cancelled', status: 'CANCELLED', currentOperation: '' }),
            working,
          ]}
        />
      </div>

      <div className="flex w-96 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <AuthorRequestLog
          requests={[request({ id: 'req-3', status: 'FAILED', error: 'The document changed under the request.' })]}
        />
      </div>
    </div>
  ),
};
