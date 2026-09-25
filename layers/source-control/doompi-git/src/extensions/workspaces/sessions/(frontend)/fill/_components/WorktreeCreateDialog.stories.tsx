import { slotPropsFixture } from '@agimon-ai/doompi-core/webTesting';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@agimon-ai/doompi-web-components';

import { worktreeActivity, worktreeCreateDialog } from '../../_lib/worktreesActivityStore';
import { WorktreeCreateOverlay, WorktreeSessionMenu } from './WorktreeCreateDialog';

const meta = {
  title: 'Git/WorktreeCreateDialog',
  component: WorktreeCreateOverlay,
  tags: ['style-system'],
};

export default meta;

function preview(error?: string) {
  const sessionId = 'story-worktree-dialog';
  worktreeActivity.update(sessionId, () => ({
    worktrees: [],
    pending: undefined,
    error,
    ...(error === undefined ? {} : { errorTarget: { action: 'create' as const } }),
  }));
  worktreeCreateDialog.update(() => ({ sessionId }));
  return (
    <div className="min-h-screen bg-doom-bg">
      <WorktreeCreateOverlay {...slotPropsFixture({ sessionId }).props} />
    </div>
  );
}

export const Playground = { render: () => preview() };
export const CreateError = { render: () => preview('This branch already has a worktree. Choose another branch name.') };
export const SessionMenu = {
  render: () => (
    <div className="min-h-screen bg-doom-bg p-6">
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger asChild>
          <Button>Session actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <WorktreeSessionMenu {...slotPropsFixture().props} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ),
};
