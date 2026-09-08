/*
 * Plain CSF objects; the style-system renderer parses these files statically
 * and mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`. The props come from the contracts
 * package's own testing fixture rather than a hand-rolled stub, so a change to
 * the slot contract breaks this story at the type level.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { SubagentToolMessage } from './SubagentToolMessage.tsx';

const props = (overrides: Omit<Parameters<typeof toolMessagePropsFixture>[0], 'toolName'>) =>
  toolMessagePropsFixture({ toolName: 'subagent', ...overrides }).props;

const LAUNCHED = ['started 2 runs:', '  run-8f21 · reviewer', '  run-8f22 · tester'].join('\n');

/** Longer than COLLAPSED_RESULT_LINES, so the card offers the "more line(s)" expander. */
const FLEET = [
  'fleet: 3 active, 2 finished',
  '',
  'run-8f21 reviewer   running  4m   read · packages/core',
  'run-8f22 tester     running  4m   bash · pnpm test',
  'run-8f19 scout      queued   0s',
  'run-8f14 reviewer   done     11m  summary: two defects filed',
  'run-8f02 tester     failed   2m   error: typecheck did not pass',
  '',
  'tokens 184.2k · cost $0.41',
  'restore: subagent {action:"restore", id:"run-8f02"}',
  'steer:   subagent {action:"steer", id:"run-8f21", message:"…"}',
  'stop:    subagent {action:"stop", id:"run-8f21"}',
  'suspended: 1 transcript kept',
  'logs under ~/.pi/agent/doom-runner',
].join('\n');

const meta = {
  title: 'Team/SubagentToolMessage',
  component: SubagentToolMessage,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex max-w-4xl flex-col gap-6 bg-doom-bg p-6">
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">run · two agents launched</span>
        <SubagentToolMessage
          {...props({
            args: {
              action: 'run',
              requests: [
                { agent: 'reviewer', task: 'review the team stories' },
                { agent: 'tester', task: 'run the affected suites' },
              ],
            },
            output: LAUNCHED,
          })}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">status · fleet, collapsed</span>
        <SubagentToolMessage {...props({ args: { action: 'status' }, output: FLEET })} />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">status · one run, still going</span>
        <SubagentToolMessage
          {...props({
            args: { action: 'status', id: 'run-8f21' },
            output: 'run-8f21 reviewer running 4m\nreading packages/core/doompi-web-contracts',
            running: true,
          })}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">steer · acknowledged</span>
        <SubagentToolMessage
          {...props({
            args: { action: 'steer', id: 'run-8f21', message: 'skip the layout pass, cover the empty states' },
            output: 'run-8f21 acknowledged the guidance',
          })}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">agents · no output</span>
        <SubagentToolMessage {...props({ args: { action: 'agents' }, output: '' })} />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">stop · failed</span>
        <SubagentToolMessage
          {...props({
            args: { action: 'stop', id: 'run-0000' },
            output: 'no run named run-0000',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
