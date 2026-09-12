/*
 * Plain CSF objects: the style-system renderer parses this file statically and
 * mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { GoalToolMessage } from './GoalToolMessage';

const props = (overrides: Parameters<typeof toolMessagePropsFixture>[0]) => toolMessagePropsFixture(overrides).props;

const completeResult = {
  content: [{ type: 'text', text: 'goal recorded as complete' }],
  details: null,
};

const blockedResult = {
  content: [{ type: 'text', text: 'goal marked blocked after 3 turns' }],
  details: null,
};

const refusedResult = {
  content: [{ type: 'text', text: 'no goal is active in this session' }],
  details: { error: true },
};

const meta = {
  title: 'Goal/GoalToolMessage',
  component: GoalToolMessage,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running</span>
        <GoalToolMessage
          {...props({
            toolName: 'goal_complete',
            args: { goal_id: 'g-41', summary: 'shipped the plan panel' },
            running: true,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">goal_complete · expandable</span>
        <GoalToolMessage
          {...props({
            toolName: 'goal_complete',
            args: { goal_id: 'g-41', summary: 'shipped the plan panel and its activity row' },
            result: completeResult,
            output: 'goal recorded as complete',
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">goal_blocked · turn count</span>
        <GoalToolMessage
          {...props({
            toolName: 'goal_blocked',
            args: {
              goal_id: 'g-41',
              reason: 'the hub refuses the save route without a session token',
              evidence: 'PUT /plan/content answered 401 on three attempts',
              repeated_turns: 3,
            },
            result: blockedResult,
            output: 'goal marked blocked after 3 turns',
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">refused</span>
        <GoalToolMessage
          {...props({
            toolName: 'goal_complete',
            args: { goal_id: 'g-41', summary: 'shipped the plan panel' },
            result: refusedResult,
            output: 'no goal is active in this session',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
