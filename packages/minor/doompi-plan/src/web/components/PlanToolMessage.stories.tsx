/*
 * Plain CSF objects: the style-system renderer parses this file statically and
 * mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { PlanToolMessage } from './PlanToolMessage.tsx';

const props = (overrides: Parameters<typeof toolMessagePropsFixture>[0]) => toolMessagePropsFixture(overrides).props;

const text = (value: string) => ({ content: [{ type: 'text', text: value }], details: null });

const meta = {
  title: 'Plan/PlanToolMessage',
  component: PlanToolMessage,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">record_debug_evidence · recorded</span>
        <PlanToolMessage
          {...props({
            toolName: 'record_debug_evidence',
            args: {
              issue: 'the plan tab reopens empty after a rewrite',
              expectedBehavior: 'the tab shows the plan on disk',
              logs: ['GET /plan/current 200', 'GET /plan/current 404'],
              verifiedFacts: ['the status stamp changed between the two reads'],
            },
            result: { content: [], details: { recorded: true } },
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">run_fable_plan · draft returned</span>
        <PlanToolMessage
          {...props({
            toolName: 'run_fable_plan',
            args: {
              goal: ['ship story coverage for every plugin package'],
              constraints: ['no component source changes'],
              decisions: ['plain CSF, one Playground export'],
              currentPlan: '# plan\n\n1. read each component',
            },
            result: {
              content: [],
              details: {
                started: true,
                status: 'completed',
                draft:
                  '1. read each component signature\n2. write one story per component\n3. render and check the png',
              },
            },
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">write_plan · in flight</span>
        <PlanToolMessage
          {...props({
            toolName: 'write_plan',
            args: {},
            result: { content: [], details: { phase: 'writing', path: '.doom/plans/story-coverage.md' } },
            running: true,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">write_plan · written</span>
        <PlanToolMessage
          {...props({
            toolName: 'write_plan',
            args: {},
            result: { content: [], details: { written: true, path: '.doom/plans/story-coverage.md', durationMs: 42 } },
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete_plan · exited</span>
        <PlanToolMessage
          {...props({
            toolName: 'complete_plan',
            args: { decision: 'exit plan mode' },
            result: { content: [{ type: 'text', text: 'implementation starts now' }], details: { exited: true } },
            output: 'implementation starts now',
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <PlanToolMessage
          {...props({
            toolName: 'write_plan',
            args: {},
            result: text('the plan file moved under the editor'),
            output: 'the plan file moved under the editor',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
