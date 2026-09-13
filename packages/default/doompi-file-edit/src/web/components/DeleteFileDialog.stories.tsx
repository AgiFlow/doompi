/*
 * Plain CSF objects; the style-system renderer parses these files statically
 * and mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 *
 * The dialog portals to the body, so only the open one is worth a variant: the
 * closed dialog renders nothing at all.
 */
import { DeleteFileDialog } from './DeleteFileDialog';

const noop = (): void => {};

const meta = {
  title: 'Files/DeleteFileDialog',
  component: DeleteFileDialog,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">open · confirming a delete</span>
        <DeleteFileDialog relPath="src/web/lib/fileView.ts" open onConfirm={noop} onCancel={noop} />
      </div>
    </div>
  ),
};
