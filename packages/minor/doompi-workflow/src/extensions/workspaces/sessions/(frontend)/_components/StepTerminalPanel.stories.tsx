/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The slot props come from the contracts package's own testing
 * fixture rather than a hand-rolled stub.
 *
 * The panel attaches a terminal that streams from the runner, which the
 * headless renderer has no backend for. What a story can show is the frame:
 * the header naming the job and step, and the empty terminal body. A customRun
 * step shows its agent session instead; the host's conversation view is a
 * stand-in here, since the headless renderer has no session to draw.
 */
import { bindSessionApiWorkspace } from '@agimon-ai/doompi-core/web';
import { slotPropsFixture } from '@agimon-ai/doompi-core/webTesting';

import type { WorkflowRunView } from '../../../../../types/webWorkflows';
import { workflows } from '../_lib/workflowsStore';
import { StepTerminalPanel, type StepTabTarget } from './StepTerminalPanel';

/*
 * The cockpit host resolves which workspace owns a session, and a story has no
 * host. Without this the generated client throws while building its first URL,
 * which happens inside the effect this story's component runs on mount.
 */
bindSessionApiWorkspace(() => 'stories');

const props = slotPropsFixture({ sessionId: 'step-terminal' }).props;

const AGENT_SESSION_ID = 'step-conversation';
const agentRun: WorkflowRunView = {
  runKey: 'dev-fix-7',
  workspace: 'doompi',
  displayName: 'dev-fix-7',
  workflowPath: 'automations/workflows/dev-fix.workflow.yml',
  stage: 'running',
  startedAt: '2026-09-27T10:00:00.000Z',
  jobs: [
    {
      name: 'diagnose',
      phase: 'job',
      status: 'running',
      steps: [
        {
          name: 'Diagnose the defect',
          status: 'running',
          ref: { kind: 'session', id: 'child-session', label: 'dev-fix: diagnose > Diagnose the defect' },
        },
      ],
    },
  ],
};
workflows.update(AGENT_SESSION_ID, (current) => ({ ...current, runs: [agentRun] }));
const agentProps = slotPropsFixture({
  sessionId: AGENT_SESSION_ID,
  sessionTranscript: (sessionId) => (
    <div className="flex flex-col gap-2 p-3 text-sm text-doom-text">
      <span className="text-2xs text-doom-dim uppercase tracking-widest">conversation of {sessionId}</span>
      <span>Reproducing the login failure with the smallest request that triggers it.</span>
      <span className="text-doom-dim">read src/auth/session.ts</span>
    </div>
  ),
}).props;
const agentTarget: StepTabTarget = {
  workspace: 'doompi',
  runKey: 'dev-fix-7',
  job: 'diagnose',
  step: 'Diagnose the defect',
};

const target: StepTabTarget = {
  workspace: 'doompi',
  runKey: 'release-14',
  job: 'build',
  step: 'pnpm build',
};

const jobOnly: StepTabTarget = {
  workspace: 'doompi',
  runKey: 'release-14',
  job: 'test',
};

const meta = {
  title: 'Workflow/StepTerminalPanel',
  component: StepTerminalPanel,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">job and step</span>
        <div className="h-56 w-full max-w-3xl rounded-md border border-doom-border bg-doom-deep">
          <StepTerminalPanel {...props} target={target} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">customRun step as an agent session</span>
        <div className="flex h-56 w-full max-w-3xl flex-col rounded-md border border-doom-border bg-doom-deep">
          <StepTerminalPanel {...agentProps} target={agentTarget} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">job with no step named</span>
        <div className="h-56 w-full max-w-3xl rounded-md border border-doom-border bg-doom-deep">
          <StepTerminalPanel {...props} target={jobOnly} />
        </div>
      </div>
    </div>
  ),
};
