import { StoryFrame, seedStorySession } from '../../components/Story.fixture.tsx';
import type { DialogMethod } from '../../lib/sessionModel.ts';
import { DialogOverlay } from './DialogOverlay.tsx';

const meta = { title: 'Web/Dialogs/DialogOverlay', component: DialogOverlay, tags: ['style-system'] };
export default meta;

function preview(method: DialogMethod) {
  seedStorySession({
    dialog: {
      id: `story-${method}`,
      method,
      title: 'Review the requested operation',
      message:
        method === 'select'
          ? 'pnpm test --filter component-stories'
          : 'Confirm the next step or provide additional context for the agent.',
      options: ['Allow this operation', 'Allow for this session', 'Decline and explain why'],
      placeholder: 'Add a note',
      prefill:
        method === 'editor'
          ? 'Review spacing, button size, and color contrast.\nKeep the existing behavior unchanged.'
          : '',
    },
  });
  return (
    <StoryFrame>
      <DialogOverlay />
    </StoryFrame>
  );
}
export const Playground = { render: () => preview('select') };
export const Confirm = { render: () => preview('confirm') };
export const Input = { render: () => preview('input') };
export const Editor = { render: () => preview('editor') };
