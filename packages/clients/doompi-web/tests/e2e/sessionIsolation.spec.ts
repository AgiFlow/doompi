import { expect, test } from '../support/cockpit';

test.use({ sessionCount: 2, assets: 'synced' });

test('creates from the clicked session card without retargeting to the focused session', async ({ page, cockpit }) => {
  expect(cockpit.channels).toContain('git_worktrees');
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await expect(page.getByTestId('session-card-s1')).toHaveAttribute('data-active', 'true');
  await page.getByTestId('session-card-s2').hover();
  await page.getByTestId('session-menu-s2').click();
  await page.getByTestId('session-worktree-s2').click();
  const dialog = page.getByTestId('session-worktree-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('session-card-s1')).toHaveAttribute('data-active', 'true');
  await dialog.getByTestId('git-worktree-branch').fill('wt/isolated');
  await dialog.getByTestId('git-worktree-create').click();
  // The fixture directory is deliberately not a repository. The real Git guard
  // must report the clicked session's directory, without creating anything.
  await expect(dialog.getByTestId('git-worktree-error')).toContainText(cockpit.sessions[1].cwd);
  await expect(dialog.getByTestId('git-worktree-error')).toContainText('not inside a git repository');
});

test('shows worktree setup progress and recovery without parent runtime actions', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  const setup = {
    id: 'reserved-child',
    name: 'conversation child',
    createdAt: new Date().toISOString(),
    setupKind: 'managed-worktree' as const,
  };
  cockpit.publishPendingSetups('s2', [{ ...setup, status: 'provisioning' }]);
  const pending = page.getByTestId('pending-session-reserved-child');
  await expect(pending).toBeVisible();
  await expect(pending).toContainText('automatic worktree provisioning');
  await page.getByTestId('pending-session-menu-reserved-child').click();
  await expect(page.getByRole('menuitem', { name: 'resume', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'restart', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'choose existing directory…' })).toHaveCount(0);
  await expect(page.getByTestId('session-worktree-reserved-child')).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'remove setup', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  cockpit.publishPendingSetups('s2', [{ ...setup, status: 'failed', errorCode: 'SESSION_WORKTREE_PROVISION_FAILED' }]);
  await expect(pending.getByRole('alert')).toContainText('retry the authenticated conversation');
  await expect(pending).toContainText('automatic worktree setup failed');

  cockpit.publishPendingSetups('s2', [{ ...setup, status: 'interrupted' }]);
  await expect(pending).toContainText('automatic worktree setup interrupted');
  await expect(pending.getByRole('alert')).toHaveCount(0);

  cockpit.publishPendingSetups('s2', [{ ...setup, setupKind: 'existing-directory', status: 'failed' }]);
  await expect(pending).toContainText('conversation directory setup failed');
  await expect(pending).toContainText('Inspect the selected directory');

  cockpit.publishPendingSetups('s2', [
    { ...setup, setupKind: undefined, cwd: '/legacy/checkout', status: 'interrupted' },
  ]);
  await expect(pending).toContainText('no verified provider');
  cockpit.publishPendingSetups('s2', []);
  await expect(pending).toHaveCount(0);
  await expect(page.getByTestId('session-card-s2')).toBeVisible();
  await expect(page.getByTestId('session-card-s2')).toHaveAttribute('data-active', 'false');
  await expect(page.locator('[data-testid^="workspace-group-"]')).toHaveCount(1);
});
