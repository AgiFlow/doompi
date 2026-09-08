/*
 * Plain CSF objects: the style-system renderer parses this file statically and
 * mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 *
 * One open dialog only. DialogContent is a centred fixed portal behind a
 * scrim, so a second open instance would sit exactly on top of the first.
 */
import { EditGoalDialog } from './EditGoalDialog.tsx';

const noop = (): void => undefined;

const meta = {
  title: 'Goal/EditGoalDialog',
  component: EditGoalDialog,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">open · budgeted goal</span>
        <EditGoalDialog
          open
          objective="ship the plan panel and its activity row"
          budgetHint="100k"
          onSubmit={noop}
          onCancel={noop}
        />
      </div>
    </div>
  ),
};
