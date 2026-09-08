/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * finding a bare `const meta`, so it is not named at the point of definition.
 */
import type { SavedPromptView } from '../../types/webPrompts.ts';
import { PromptPickerList } from './PromptPickerList.tsx';

const prompts: readonly SavedPromptView[] = [
  {
    name: 'ship-it',
    description: 'run the affected targets, then report what changed',
    text: 'Run the affected Nx lint, typecheck, build and test targets, then report what changed.',
  },
  {
    name: 'review-diff',
    description: 'review the working tree for concrete defects',
    text: 'Review the working tree for defects, regressions and missing tests. Name files and lines.',
  },
  {
    name: 'explain-this-flow',
    description: 'trace one flow end to end before touching it',
    text: 'Trace this flow from entry point to persistence and list every side effect on the way.',
  },
];

const noop = () => undefined;

const handlers = {
  onFilterChange: noop,
  onSend: noop,
  onEdit: noop,
  onDelete: noop,
  onRetry: noop,
};

const meta = {
  title: 'Prompt/PromptPickerList',
  component: PromptPickerList,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">a loaded library</span>
        <PromptPickerList prompts={prompts} filter="" loading={false} busy={false} error="" {...handlers} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">filtered to one</span>
        <PromptPickerList prompts={prompts} filter="review" loading={false} busy={false} error="" {...handlers} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">filter matches nothing</span>
        <PromptPickerList prompts={prompts} filter="deploy" loading={false} busy={false} error="" {...handlers} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">nothing saved yet</span>
        <PromptPickerList prompts={[]} filter="" loading={false} busy={false} error="" {...handlers} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">loading</span>
        <PromptPickerList prompts={[]} filter="" loading busy={false} error="" {...handlers} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">the hub refused</span>
        <PromptPickerList
          prompts={[]}
          filter=""
          loading={false}
          busy={false}
          error="The hub did not answer."
          {...handlers}
        />
      </div>
    </div>
  ),
};
