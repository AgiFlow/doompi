/*
 * Plain CSF objects: the style-system renderer parses this file statically and
 * mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 *
 * The row reads the session's own footer status, so the variants are status
 * lines in the shape `formatGoalStatusView` writes, not hand-built view models.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';

import { GOAL_VIEW_STATUS_KEY, formatGoalStatusView } from '../../types/goalView';
import { GoalActivitySection } from './GoalActivitySection';

const slot = (status?: string, sessionId: string | null = 's1') =>
  slotPropsFixture({
    sessionId,
    statuses: status === undefined ? {} : { [GOAL_VIEW_STATUS_KEY]: status },
  }).props;

const meta = {
  title: 'Goal/GoalActivitySection',
  component: GoalActivitySection,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no goal set</span>
        <GoalActivitySection {...slot()} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">budgeted goal</span>
        <GoalActivitySection
          {...slot(formatGoalStatusView('ship the plan panel and its activity row', 'active 12.4k/100k'))}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">unbudgeted goal</span>
        <GoalActivitySection {...slot(formatGoalStatusView('keep the cockpit render pipeline green', 'active 3.1k'))} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no session · menu disabled</span>
        <GoalActivitySection
          {...slot(formatGoalStatusView('ship the plan panel and its activity row', 'active 12.4k/100k'), null)}
        />
      </div>
    </div>
  ),
};
