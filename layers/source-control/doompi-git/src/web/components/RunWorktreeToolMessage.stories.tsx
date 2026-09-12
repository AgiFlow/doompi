/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the tool contract breaks this
 * story at the type level instead of silently drifting.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { RunWorktreeToolMessage } from './RunWorktreeToolMessage';

const LISTING = [
  'wt/fix-auth  ~/.pi/.doom/git/worktrees/fix-auth  session s7',
  'wt/split-hub  ~/.pi/.doom/git/worktrees/split-hub  orphaned',
].join('\n');

const props = (overrides: Omit<Parameters<typeof toolMessagePropsFixture>[0], 'toolName'>) =>
  toolMessagePropsFixture({ toolName: 'run_worktree', ...overrides }).props;

const meta = {
  title: 'Git/RunWorktreeToolMessage',
  component: RunWorktreeToolMessage,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running · branch in the heading</span>
        <RunWorktreeToolMessage
          {...props({ args: { action: 'spawn_worktree', branch: 'wt/fix-auth' }, running: true })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete · listing</span>
        <RunWorktreeToolMessage {...props({ args: { action: 'list' }, output: LISTING })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete · id in the heading</span>
        <RunWorktreeToolMessage
          {...props({ args: { action: 'close_worktree', id: 'a1b2c3d4' }, output: 'closed wt/fix-auth' })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <RunWorktreeToolMessage
          {...props({
            args: { action: 'close_worktree', id: 'a1b2c3d4' },
            output: 'refusing to close a dirty worktree; pass force to override',
            isError: true,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">unknown action</span>
        <RunWorktreeToolMessage {...props({ args: { action: 'rebase' }, output: 'unsupported action' })} />
      </div>
    </div>
  ),
};
