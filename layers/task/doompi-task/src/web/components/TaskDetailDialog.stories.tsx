/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition.
 *
 * One dialog only. The component owns its DialogContent, which is portalled to
 * document.body and centred, so a second mode rendered beside it would land on
 * exactly the same pixels; edit and message are reached from the buttons here.
 * The sender comes from the contracts package's own testing fixture, so an edit
 * is recorded rather than sent.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import type { WebTask } from '../../types/webTasks';
import { TaskDetailDialog } from './TaskDetailDialog';

const TASK: WebTask = {
  id: 12,
  subject: 'Render every plugin story and read the PNG',
  description:
    'One story file beside each component, verified through the style-system renderer. A component that cannot mount is reported rather than left broken.',
  activeForm: 'rendering stories',
  status: 'in_progress',
  blockedBy: [9, 11],
  owner: 'doompi-developer',
  updatedAt: '2025-03-04T09:41:00Z',
  delegation: { agent: 'doompi-developer', state: 'running' },
};

const slot = slotPropsFixture({ sessionId: 's1' }).props;

const meta = {
  title: 'Task/TaskDetailDialog',
  component: TaskDetailDialog,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex min-h-96 flex-col gap-6 bg-doom-bg p-6">
      <span className="text-2xs text-doom-dim uppercase tracking-widest">
        view mode · a delegated task with every fact set
      </span>
      <TaskDetailDialog task={TASK} sessionId="s1" mode="view" send={slot.sendSessionFrame} onClose={() => undefined} />
    </div>
  ),
};
