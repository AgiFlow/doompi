import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-core/webTesting';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { gitChanges } from '../../src/extensions/workspaces/sessions/(frontend)/_lib/gitChangesStore';
import { worktreeActivity } from '../../src/extensions/workspaces/sessions/(frontend)/_lib/worktreesActivityStore';
import gitGroup from '../../src/extensions/workspaces/sessions/(frontend)/activity-group/git.web';
import { WorktreesActivitySection } from '../../src/extensions/workspaces/sessions/(frontend)/fill/_components/WorktreesActivitySection';
import reviewBinding from '../../src/extensions/workspaces/sessions/(frontend)/leader/review.web';

// This check owns the dock body, not the panels its buttons launch.
vi.mock('../../src/extensions/workspaces/sessions/(frontend)/_components/GitReviewPanel', () => ({
  reviewTab: () => ({ id: 'git-review', label: 'review', panel: () => null }),
}));
vi.mock('../../src/extensions/workspaces/sessions/(frontend)/_components/WorktreesPanel', () => ({
  worktreesTab: () => ({ id: 'git-worktrees', label: 'worktrees', panel: () => null }),
}));
const SESSION = 'git-activity-test';

afterEach(() => {
  gitChanges.drop(SESSION);
  worktreeActivity.drop(SESSION);
});

describe('Git activity group', () => {
  it.each(['feat/git', 'wt/fix-auth'])('shows %s and its diff without child worktrees', (branch) => {
    gitChanges.update(SESSION, (current) => ({
      ...current,
      changes: { branch, base: 'origin/main', added: 64, removed: 12, files: 4 },
    }));
    const rendered = renderPlugin(WorktreesActivitySection, slotPropsFixture({ sessionId: SESSION }).props);
    expect(rendered.error).toBeUndefined();
    const markup = rendered.html;
    expect(markup).toContain(branch);
    expect(markup).toContain('64 added, 12 removed vs origin/main');
    expect(markup).toContain('activity-diff-changes');
    expect(markup).toContain('create a worktree');
    expect(markup).not.toContain('activity-git-worktrees');
  });

  it('keeps a clean worktree reviewable and never invents counts before a report', () => {
    const props = slotPropsFixture({ sessionId: SESSION }).props;
    expect(renderPlugin(WorktreesActivitySection, props).html).not.toContain('activity-diff-changes');
    gitChanges.update(SESSION, (current) => ({
      ...current,
      changes: { branch: 'wt/fix-auth', added: 0, removed: 0, files: 0 },
    }));
    expect(renderPlugin(WorktreesActivitySection, props).html).toContain('0 added, 0 removed uncommitted');
    expect(renderPlugin(WorktreesActivitySection, { ...props, sessionId: null }).html).not.toContain(
      'activity-diff-changes',
    );
  });

  it('shows a top-level worktree only as the current branch, while keeping other worktrees listed', () => {
    gitChanges.update(SESSION, (current) => ({
      ...current,
      changes: { branch: 'wt/self', added: 3, removed: 1, files: 1 },
    }));
    worktreeActivity.update(SESSION, (current) => ({
      ...current,
      worktrees: [
        { id: 'self', branch: 'wt/self', path: '/self', sessionId: SESSION, orphaned: false, unowned: false },
        {
          id: 'child',
          branch: 'wt/child',
          path: '/child',
          sessionId: 'child-session',
          orphaned: false,
          unowned: false,
        },
      ],
    }));
    const rendered = renderPlugin(WorktreesActivitySection, slotPropsFixture({ sessionId: SESSION }).props);
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('3 added, 1 removed uncommitted');
    expect(rendered.html).not.toContain('activity-git-worktree-self');
    expect(rendered.html).toContain('activity-git-worktree-child');
  });

  it('tracks sync and worktree activity, and unsubscribes from both', () => {
    const source = gitGroup.activeSource!;
    const listener = vi.fn();
    const stop = source.subscribe(listener);
    expect(source.isActive(SESSION)).toBe(false);
    gitChanges.update(SESSION, (current) => ({ ...current, pending: 'pushing…' }));
    expect(source.isActive(SESSION)).toBe(true);
    gitChanges.update(SESSION, (current) => ({ ...current, pending: undefined }));
    worktreeActivity.update(SESSION, (current) => ({ ...current, pending: 'creating wt/one…' }));
    expect(source.isActive(SESSION)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
    gitChanges.update(SESSION, (current) => ({ ...current, pending: 'pulling…' }));
    worktreeActivity.update(SESSION, (current) => ({ ...current, pending: undefined }));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('preserves the review shortcut separately from the worktrees heading', () => {
    expect(gitGroup.transientTab?.().id).toBe('git-worktrees');
    expect(reviewBinding.path.map((segment) => segment.key).join(' ')).toBe('g d');
    expect(reviewBinding.path[0]?.label).toBe('goal');
    const fixture = slotPropsFixture({ sessionId: SESSION });
    if ('run' in reviewBinding) reviewBinding.run(fixture.props);
    expect(fixture.actions).toEqual([{ action: 'openTransientTab', target: 'git-review' }]);
  });
});
