/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. The cursor is controlled by the surface, so the fixture pins one
 * and the callbacks do nothing.
 */
import { OptionList } from './OptionList.tsx';

const MODELS = ['claude sonnet', 'claude opus', 'qwen3 coder', 'gpt-5 codex'] as const;

const noop = () => undefined;

const meta = {
  title: 'Components/OptionList',
  component: OptionList,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">density comfortable</span>
        <OptionList
          className="max-w-sm"
          density="comfortable"
          options={MODELS}
          cursor={0}
          onCursorChange={noop}
          onSelect={noop}
          testIdPrefix="model-comfortable-option"
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">density compact</span>
        <OptionList
          className="max-w-sm rounded-md bg-doom-panel"
          density="compact"
          options={MODELS}
          cursor={2}
          onCursorChange={noop}
          onSelect={noop}
          testIdPrefix="model-compact-option"
        />
      </div>
    </div>
  ),
};
