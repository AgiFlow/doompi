/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the slot contract breaks this
 * story at the type level instead of silently drifting.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';

import { LaunchRunnerDialog } from './LaunchRunnerDialog';

const { props } = slotPropsFixture({ sessionId: 'runner-launch' });

const meta = {
  title: 'Runner/LaunchRunnerDialog',
  component: LaunchRunnerDialog,
  tags: ['style-system'],
};

export default meta;

/*
 * One dialog only: it is modal and portals into the body, so a second instance
 * would draw its overlay over the first. This is the state it opens in, with
 * the command still empty, which is also the state that shows the problem line
 * and the disabled submit.
 */
export const Playground = {
  render: () => (
    <div className="h-screen w-screen bg-doom-bg">
      <LaunchRunnerDialog
        sessionId="runner-launch"
        sendSessionFrame={props.sendSessionFrame}
        defaultCwd="/Users/doom/workspace/doompi"
        onClose={() => undefined}
      />
    </div>
  ),
};
