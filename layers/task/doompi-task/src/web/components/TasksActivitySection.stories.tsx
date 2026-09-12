/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The slot props come from the contracts package's own testing
 * fixture, and the rows come from the plugin's own session store seeded per
 * session id, which is exactly where the hub channel puts them.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import type { WebTask } from '../../types/webTasks';
import { tasks } from '../stores/tasksStore';
import { TasksActivitySection } from './TasksActivitySection';

const ACTIVE: WebTask[] = [
  {
    id: 1,
    subject: 'Render every plugin story and read the PNG',
    status: 'in_progress',
    activeForm: 'rendering stories',
    blockedBy: [],
    delegation: { agent: 'doompi-developer', state: 'running' },
  },
  {
    id: 2,
    subject: 'Report the tokens the worktrees panel names but the theme does not define',
    description: 'text-doom-error and border-doom-line resolve to nothing',
    status: 'pending',
    blockedBy: [1],
  },
];

const CLOSED: WebTask[] = [
  { id: 3, subject: 'Seed the plugin story files', status: 'completed', blockedBy: [], owner: 'main' },
  { id: 4, subject: 'Re-run the lint gate', status: 'failed', blockedBy: [] },
];

tasks.update('s-active', () => ({ tasks: ACTIVE, rev: 1 }));
tasks.update('s-mixed', () => ({ tasks: [...ACTIVE, ...CLOSED], rev: 2 }));

const slot = (sessionId: string) => slotPropsFixture({ sessionId }).props;

const meta = {
  title: 'Task/TasksActivitySection',
  component: TasksActivitySection,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex w-80 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">active only</span>
        <TasksActivitySection {...slot('s-active')} />
      </div>

      <div className="flex w-80 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">active · session history collapsed</span>
        <TasksActivitySection {...slot('s-mixed')} />
      </div>

      <div className="flex w-80 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          no tasks · the section has no cockpit presence
        </span>
        <TasksActivitySection {...slot('s-empty')} />
      </div>
    </div>
  ),
};
