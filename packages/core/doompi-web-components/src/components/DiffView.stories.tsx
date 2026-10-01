/*
 * Plain CSF objects rather than Storybook's Meta and StoryObj: the renderer
 * parses these files statically and mounts the exported `render`, so no
 * Storybook runtime is installed.
 */
import type { DiffHunk } from '../types/diff';
import { DiffView } from './DiffView';
import { ReviewCommentDraft } from './ReviewCommentDraft';

const HUNKS: DiffHunk[] = [
  {
    start: 12,
    rows: [
      { marker: ' ', line: 12, content: "import { execFile } from 'node:child_process';" },
      { marker: '-', line: 13, content: "import fs from 'node:fs';" },
      { marker: '+', line: 13, content: "import fs from 'node:fs/promises';" },
      { marker: '+', line: 14, content: "import path from 'node:path';" },
      { marker: ' ', line: 15, content: '' },
    ],
  },
  {
    start: 88,
    rows: [
      { marker: ' ', line: 88, content: '  async removeWorktree({ repositoryRoot, path, force }) {' },
      { marker: '-', line: 87, content: "    const args = ['worktree', 'remove', path];" },
      {
        marker: '+',
        line: 89,
        content: "    const args = ['worktree', 'remove', ...(force ? ['--force'] : []), path];",
      },
      { marker: ' ', line: 90, content: '    const result = await git(repositoryRoot, args, REMOVE_TIMEOUT_MS);' },
    ],
  },
];

const noop = (): void => undefined;

const meta = {
  title: 'Components/DiffView',
  component: DiffView,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex w-[720px] flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">read only</span>
        <div className="rounded-md border border-doom-border-soft bg-doom-panel py-1">
          <DiffView hunks={HUNKS} testId="diff-read-only" />
        </div>
      </div>

      <div className="flex w-[720px] flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">commentable · line numbers are buttons</span>
        <div className="rounded-md border border-doom-border-soft bg-doom-panel py-1">
          <DiffView hunks={HUNKS} testId="diff-commentable" onSelect={noop} />
        </div>
      </div>

      <div className="flex w-[720px] flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">inline draft under a removed line</span>
        <div className="rounded-md border border-doom-border-soft bg-doom-panel py-1">
          <DiffView
            hunks={HUNKS}
            testId="diff-inline"
            onSelect={noop}
            renderAfterRow={(row) =>
              row.marker === '-' && row.line === 13 ? (
                <ReviewCommentDraft snippet={row.content} startLine={13} side="old" onSubmit={noop} onCancel={noop} />
              ) : null
            }
          />
        </div>
      </div>

      <div className="flex w-[720px] flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">empty</span>
        <DiffView hunks={[]} testId="diff-empty" />
      </div>
    </div>
  ),
};
