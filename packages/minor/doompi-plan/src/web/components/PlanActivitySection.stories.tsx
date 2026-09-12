/*
 * Plain CSF objects: the style-system renderer parses this file statically and
 * mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';
import { PlanActivitySection } from './PlanActivitySection';
import { formatPlanStatus, PLAN_STATUS_KEY } from '../../types/planApi';

const slot = (status?: string, sessionId: string | null = 's1') =>
  slotPropsFixture({
    sessionId,
    statuses: status === undefined ? {} : { [PLAN_STATUS_KEY]: status },
  }).props;

const meta = {
  title: 'Plan/PlanActivitySection',
  component: PlanActivitySection,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no plan written</span>
        <PlanActivitySection {...slot()} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">plan with a write stamp</span>
        <PlanActivitySection {...slot(formatPlanStatus('Cockpit story coverage for plugin packages', '14:32'))} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no stamp</span>
        <PlanActivitySection {...slot('Migrate every plugin web tree onto the shared style-system render pipeline')} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no session · open disabled</span>
        <PlanActivitySection {...slot(formatPlanStatus('Cockpit story coverage', '14:32'), null)} />
      </div>
    </div>
  ),
};
