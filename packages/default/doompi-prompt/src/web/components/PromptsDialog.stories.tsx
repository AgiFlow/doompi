/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * finding a bare `const meta`, so it is not named at the point of definition.
 *
 * One open dialog only: this portals to the document body over a modal
 * overlay, so a second open instance would stack on top of the first rather
 * than sit beside it. The states behind the picker (editor, confirmations) are
 * reached by interaction, and their bodies have their own stories.
 */
import type { SavedPromptView } from '../../types/webPrompts.ts';
import { PromptsDialog } from './PromptsDialog.tsx';

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

const meta = {
  title: 'Prompt/PromptsDialog',
  component: PromptsDialog,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          open · the picker over a loaded library
        </span>
        <PromptsDialog
          open
          prompts={prompts}
          loading={false}
          loadError=""
          sessionId="s1"
          onOpenChange={() => undefined}
          onReload={() => Promise.resolve()}
          onSend={() => undefined}
        />
      </div>
    </div>
  ),
};
