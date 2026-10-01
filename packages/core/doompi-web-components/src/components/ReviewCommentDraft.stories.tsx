/*
 * Plain CSF objects rather than Storybook's Meta and StoryObj: the renderer
 * parses these files statically and mounts the exported `render`, so no
 * Storybook runtime is installed.
 */
import { ReviewCommentDraft } from './ReviewCommentDraft';

const SNIPPET = [
  "    const args = ['worktree', 'remove', ...(force ? ['--force'] : []), path];",
  '    const result = await git(repositoryRoot, args, REMOVE_TIMEOUT_MS);',
].join('\n');

const noop = (): void => undefined;

const meta = {
  title: 'Components/ReviewCommentDraft',
  component: ReviewCommentDraft,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex w-[560px] flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">new side · range</span>
        <div className="rounded-md border border-doom-border-soft bg-doom-panel">
          <ReviewCommentDraft snippet={SNIPPET} startLine={89} endLine={90} onSubmit={noop} onCancel={noop} />
        </div>
      </div>

      <div className="flex w-[560px] flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">old side · one removed line</span>
        <div className="rounded-md border border-doom-border-soft bg-doom-panel">
          <ReviewCommentDraft
            snippet="    const args = ['worktree', 'remove', path];"
            startLine={87}
            side="old"
            onSubmit={noop}
            onCancel={noop}
          />
        </div>
      </div>

      <div className="flex w-[560px] flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no line anchor</span>
        <div className="rounded-md border border-doom-border-soft bg-doom-panel">
          <ReviewCommentDraft
            snippet="Worktree sessions opened here start at the top level"
            onSubmit={noop}
            onCancel={noop}
          />
        </div>
      </div>
    </div>
  ),
};
