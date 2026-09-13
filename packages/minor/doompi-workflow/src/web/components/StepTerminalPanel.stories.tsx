/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The slot props come from the contracts package's own testing
 * fixture rather than a hand-rolled stub.
 *
 * The panel attaches a terminal that streams from the runner, which the
 * headless renderer has no backend for. What a story can show is the frame:
 * the header naming the job and step, and the empty terminal body.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';

import { StepTerminalPanel, type StepTabTarget } from './StepTerminalPanel';

const props = slotPropsFixture({ sessionId: 'step-terminal' }).props;

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
        <span className="text-2xs text-doom-dim uppercase tracking-widest">job with no step named</span>
        <div className="h-56 w-full max-w-3xl rounded-md border border-doom-border bg-doom-deep">
          <StepTerminalPanel {...props} target={jobOnly} />
        </div>
      </div>
    </div>
  ),
};
