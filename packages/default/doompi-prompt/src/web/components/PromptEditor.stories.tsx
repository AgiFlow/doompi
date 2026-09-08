/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * finding a bare `const meta`, so it is not named at the point of definition.
 *
 * The drafts are typed as DraftState, so the save button's enabled state here
 * is the component's own rule rather than a claim this file makes.
 */
import type { DraftState } from '../lib/promptsActions.ts';
import { PromptEditor } from './PromptEditor.tsx';

const empty: DraftState = { name: '', text: '', original: '' };

const filled: DraftState = {
  name: 'ship-it',
  text: 'Run the affected Nx lint, typecheck, build and test targets, then report what changed.',
  original: '',
};

const editing: DraftState = { ...filled, original: 'ship-it' };

const meta = {
  title: 'Prompt/PromptEditor',
  component: PromptEditor,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">new · empty, save disabled</span>
        <PromptEditor
          draft={empty}
          busy={false}
          onChange={() => undefined}
          onSave={() => undefined}
          onCancel={() => undefined}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">new · complete, save enabled</span>
        <PromptEditor
          draft={filled}
          busy={false}
          onChange={() => undefined}
          onSave={() => undefined}
          onCancel={() => undefined}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">editing an existing prompt</span>
        <PromptEditor
          draft={editing}
          busy={false}
          onChange={() => undefined}
          onSave={() => undefined}
          onCancel={() => undefined}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">saving</span>
        <PromptEditor
          draft={editing}
          busy
          onChange={() => undefined}
          onSave={() => undefined}
          onCancel={() => undefined}
        />
      </div>
    </div>
  ),
};
