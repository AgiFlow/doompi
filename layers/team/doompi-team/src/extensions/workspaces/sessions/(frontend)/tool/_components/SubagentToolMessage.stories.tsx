/*
 * Plain CSF objects; the style-system renderer parses these files statically
 * and mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`. The props come from the contracts
 * package's own testing fixture rather than a hand-rolled stub, so a change to
 * the slot contract breaks this story at the type level.
 *
 * Every fixture below is a real payload: the `text` is what the headless
 * `subagent` tool hands the model and `details` is what it attaches for this
 * card, so a story cannot drift into wording no code path produces.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-core/web/testing';

import { SubagentToolMessage } from './SubagentToolMessage';

const props = (overrides: Omit<Parameters<typeof toolMessagePropsFixture>[0], 'toolName'>) =>
  toolMessagePropsFixture({ toolName: 'subagent', ...overrides }).props;

const resultOf = (text: string, details: unknown) => ({ content: [{ type: 'text', text }], details });

const RUN_DETAILS = {
  outcomes: [
    { agent: 'reviewer', task: 'review the team stories', childIndex: 0, runId: 'run-8f21' },
    { agent: 'tester', task: 'run the affected suites', childIndex: 1, runId: 'run-8f22' },
    { agent: 'scout', task: 'map the cockpit routes', childIndex: 2, error: 'no executable agent named scout' },
  ],
};
const RUN_TEXT = [
  'Started 2/3 subagents; 1 failed:',
  '- reviewer: run-8f21',
  '- tester: run-8f22',
  '- scout: failed: no executable agent named scout',
  '',
  'Completion will arrive asynchronously for started runs. Do not resubmit them; retry only corrected failed entries.',
].join('\n');

/** More rows than the collapse budget, so the card offers the "more" expander. */
const FLEET_DETAILS = {
  runs: [
    { runId: 'run-8f21', agent: 'reviewer', status: 'running', activityState: 'working', currentTool: 'read' },
    { runId: 'run-8f22', agent: 'tester', status: 'running', currentTool: 'bash' },
    { runId: 'run-8f19', agent: 'scout', status: 'queued' },
    { runId: 'run-8f18', agent: 'reviewer', status: 'completed' },
    { runId: 'run-8f17', agent: 'tester', status: 'failed', error: 'typecheck did not pass' },
    { runId: 'run-8f16', agent: 'writer', status: 'completed' },
    { runId: 'run-8f15', agent: 'writer', status: 'completed' },
    { runId: 'run-8f14', agent: 'reviewer', status: 'completed' },
    { runId: 'run-8f13', agent: 'scout', status: 'stopped' },
    { runId: 'run-8f12', agent: 'tester', status: 'completed' },
  ],
};
const FLEET_TEXT = [
  '10 active runs:',
  ...FLEET_DETAILS.runs.map((run) => `- ${run.runId} · ${run.status} · 4m`),
  '',
  'Inspect one with { action: "status", id: "<run id>", transcriptLines: 80 }.',
].join('\n');

const AGENTS_DETAILS = {
  agents: [
    { name: 'reviewer', source: 'project', description: 'Reviews a diff against the repository rules', runtime: 'pi' },
    { name: 'tester', source: 'user', description: 'Runs the suites a change touches', runtime: 'pi' },
  ],
};
const AGENTS_TEXT = [
  'Executable agents:',
  '- reviewer (project): Reviews a diff against the repository rules',
  '- tester (user): Runs the suites a change touches',
].join('\n');

const STEER_TEXT = "Steer request 'steer-1' for 'run-8f21' is delivered: accepted";
const STEER_DETAILS = {
  runId: 'run-8f21',
  steer: { requestId: 'steer-1', index: 0, state: 'delivered', message: 'accepted' },
};

const RUNNING_TEXT = 'Starting 2 subagents...';
const ERROR_TEXT = "No current-session run found for 'run-0000'.";

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
        <span className="text-2xs text-doom-dim uppercase tracking-widest">run · two started, one failed</span>
        <SubagentToolMessage
          {...props({
            args: {
              action: 'run',
              requests: [
                { agent: 'reviewer', task: 'review the team stories' },
                { agent: 'tester', task: 'run the affected suites' },
                { agent: 'scout', task: 'map the cockpit routes' },
              ],
            },
            result: resultOf(RUN_TEXT, RUN_DETAILS),
            output: RUN_TEXT,
          })}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">status · fleet, collapsed to 8 rows</span>
        <SubagentToolMessage
          {...props({ args: { action: 'status' }, result: resultOf(FLEET_TEXT, FLEET_DETAILS), output: FLEET_TEXT })}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">agents · the roster</span>
        <SubagentToolMessage
          {...props({
            args: { action: 'agents' },
            result: resultOf(AGENTS_TEXT, AGENTS_DETAILS),
            output: AGENTS_TEXT,
          })}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">status · one run</span>
        <SubagentToolMessage
          {...props({
            args: { action: 'status', id: 'run-8f21' },
            result: resultOf("Run 'run-8f21': running", {
              runId: 'run-8f21',
              status: { runId: 'run-8f21', agent: 'reviewer', state: 'running', activityState: 'working' },
            }),
            output: "Run 'run-8f21': running",
          })}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">steer · acknowledged</span>
        <SubagentToolMessage
          {...props({
            args: { action: 'steer', id: 'run-8f21', message: 'skip the layout pass, cover the empty states' },
            result: resultOf(STEER_TEXT, STEER_DETAILS),
            output: STEER_TEXT,
          })}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">run · still starting</span>
        <SubagentToolMessage
          {...props({
            args: {
              action: 'run',
              requests: [
                { agent: 'reviewer', task: 'review the team stories' },
                { agent: 'tester', task: 'run the affected suites' },
              ],
            },
            result: resultOf(RUNNING_TEXT, { action: 'run', partial: true }),
            output: RUNNING_TEXT,
            running: true,
          })}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">stop · failed</span>
        <SubagentToolMessage
          {...props({
            args: { action: 'stop', id: 'run-0000' },
            result: resultOf(ERROR_TEXT, ERROR_TEXT),
            output: ERROR_TEXT,
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
