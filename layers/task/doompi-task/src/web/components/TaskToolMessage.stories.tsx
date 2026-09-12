/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the tool contract breaks this
 * story at the type level instead of silently drifting.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-core/web/testing';
import { TaskToolMessage } from './TaskToolMessage';

const TASKS = [
  { id: 1, subject: 'Seed the plugin story files', status: 'completed', blockedBy: [] },
  {
    id: 2,
    subject: 'Render every story and read the PNG',
    status: 'in_progress',
    activeForm: 'rendering stories',
    blockedBy: [1],
    delegation: { agent: 'doompi-developer', state: 'running' },
  },
  {
    id: 3,
    subject: 'Report the tokens the panel names but the theme does not define',
    status: 'pending',
    blockedBy: [2],
  },
  { id: 4, subject: 'Re-run the lint gate', status: 'failed', blockedBy: [] },
];

const details = (extra: Record<string, unknown>) => ({ params: {}, tasks: TASKS, ...extra });

const props = (overrides: Omit<Parameters<typeof toolMessagePropsFixture>[0], 'toolName'>) =>
  toolMessagePropsFixture({ toolName: 'task', ...overrides }).props;

const meta = {
  title: 'Task/TaskToolMessage',
  component: TaskToolMessage,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running</span>
        <TaskToolMessage
          {...props({
            args: { action: 'assign', assignments: [{ id: 2, agent: 'doompi-developer' }] },
            output: 'starting doompi-developer',
            running: true,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">list · every status</span>
        <TaskToolMessage
          {...props({
            args: { action: 'list' },
            result: { content: [], details: details({ action: 'list' }) },
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">upsert · one task</span>
        <TaskToolMessage
          {...props({
            args: { action: 'upsert', tasks: [{ id: 2, status: 'in_progress' }] },
            result: {
              content: [],
              details: details({ action: 'upsert', upsert: { applied: [2], failed: 0 } }),
            },
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">assign · batch with a failure</span>
        <TaskToolMessage
          {...props({
            args: {
              action: 'assign',
              assignments: [
                { id: 2, agent: 'doompi-developer' },
                { id: 3, agent: 'doompi-reviewer' },
              ],
            },
            result: {
              content: [],
              details: details({ action: 'assign', assignment: { assigned: [2, 3], failed: 1 } }),
            },
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <TaskToolMessage
          {...props({
            args: { action: 'get', id: 9 },
            output: 'task #9 does not exist',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
