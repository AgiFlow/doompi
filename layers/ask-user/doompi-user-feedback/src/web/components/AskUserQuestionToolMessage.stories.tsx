/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the tool contract breaks this
 * story at the type level instead of silently drifting.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { AskUserQuestionToolMessage } from './AskUserQuestionToolMessage';

const ARGS = {
  questions: [
    { header: 'Scope', question: 'Which packages should the story batch cover?' },
    { header: 'Titles', question: 'Which title prefix belongs to a layer package?' },
  ],
};

const props = (overrides: Omit<Parameters<typeof toolMessagePropsFixture>[0], 'toolName'>) =>
  toolMessagePropsFixture({ toolName: 'ask_user_question', args: ARGS, ...overrides }).props;

const meta = {
  title: 'UserFeedback/AskUserQuestionToolMessage',
  component: AskUserQuestionToolMessage,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running · questionnaire is open below</span>
        <AskUserQuestionToolMessage {...props({ running: true })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">answered · single and multi select</span>
        <AskUserQuestionToolMessage
          {...props({
            result: {
              content: [],
              details: {
                answers: [
                  { question: 'Which packages should the story batch cover?', kind: 'single', answer: 'All five' },
                  {
                    question: 'Which title prefix belongs to a layer package?',
                    kind: 'multi',
                    selected: ['Git', 'Task', 'UserFeedback'],
                  },
                ],
              },
            },
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">handed to voice</span>
        <AskUserQuestionToolMessage
          {...props({
            result: {
              content: [],
              details: {
                answers: [],
                delivery: 'voice',
                voicePrompt: 'Which packages should the story batch cover, and which title prefix do layers use?',
              },
            },
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">cancelled</span>
        <AskUserQuestionToolMessage
          {...props({ result: { content: [], details: { answers: [], cancelled: true } } })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed · no details attached</span>
        <AskUserQuestionToolMessage
          {...props({ output: 'no interactive session is attached to answer the questionnaire', isError: true })}
        />
      </div>
    </div>
  ),
};
