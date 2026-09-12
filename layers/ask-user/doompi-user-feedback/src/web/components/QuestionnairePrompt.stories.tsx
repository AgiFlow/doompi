/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The timeline half of the props comes from the contracts
 * package's own testing fixture; the prompt half (the open request and the two
 * ways to settle it) is spelled out here because the fixture covers messages.
 *
 * Each block opens on its first question: the prompt shows one question at a
 * time and the arrow keys walk the rest, which a screenshot cannot press.
 */
import type { ToolPromptDialog } from '@agimon-ai/doompi-core/web';
import { toolMessagePropsFixture } from '@agimon-ai/doompi-core/web/testing';
import { QuestionnairePrompt } from './QuestionnairePrompt';

const TOOL_NAME = 'ask_user_question';
const dialog = (id: string): ToolPromptDialog => ({
  id,
  method: 'select',
  title: TOOL_NAME,
  message: 'answer to continue',
  options: [],
  placeholder: '',
  prefill: '',
});

const props = (id: string, questions: unknown[]) => ({
  ...toolMessagePropsFixture({ toolName: TOOL_NAME, args: { questions }, running: true }).props,
  dialog: dialog(id),
  answer: () => undefined,
  cancel: () => undefined,
});

const SINGLE = [
  {
    header: 'Scope',
    question: 'Which packages should the story batch cover?',
    options: [
      { label: 'All five', description: 'ui, web, git, task and user-feedback' },
      { label: 'Layers only', description: 'skip the two packages with work in flight' },
      { label: 'One package', description: 'land a pattern first, then repeat it' },
    ],
  },
  { header: 'Titles', question: 'Which title prefix belongs to a layer package?', options: [] },
];

const MULTI = [
  {
    header: 'Verification',
    question: 'Which checks must a story pass before it lands?',
    multiSelect: true,
    options: [
      { label: 'Renders', description: 'the style-system renderer returns a PNG' },
      { label: 'Formatted', description: 'oxfmt leaves the file alone' },
      { label: 'Typechecked', description: 'tsc --noEmit is clean', preview: 'pnpm exec tsc --noEmit' },
    ],
  },
];

const meta = {
  title: 'UserFeedback/QuestionnairePrompt',
  component: QuestionnairePrompt,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex max-w-3xl flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">single select · question 1 of 2</span>
        <QuestionnairePrompt {...props('q-single', SINGLE)} />
      </div>

      <div className="flex max-w-3xl flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">multi select · one question</span>
        <QuestionnairePrompt {...props('q-multi', MULTI)} />
      </div>
    </div>
  ),
};
