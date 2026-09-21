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

test('renders pending setup without runtime actions and uses the reserved target', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  cockpit.publishPendingSetups('s2', [
    { id: 'reserved-child', name: 'conversation child', createdAt: new Date().toISOString() },
  ]);
  const pending = page.getByTestId('pending-session-reserved-child');
  await expect(pending).toBeVisible();
  await expect(pending).toContainText('awaiting execution directory');
  await page.getByTestId('pending-session-menu-reserved-child').click();
  await expect(page.getByRole('menuitem', { name: 'resume', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'restart', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('session-worktree-reserved-child')).toBeVisible();
  await page.getByRole('menuitem', { name: 'choose existing directory…' }).click();
  await expect(page.getByTestId('session-directory-dialog-reserved-child')).toBeVisible();
  await expect(page.getByRole('button', { name: 'create session', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'cancel', exact: true }).click();
  await page.getByTestId('pending-session-menu-reserved-child').click();
  await page.getByTestId('session-worktree-reserved-child').click();
  await expect(page.getByTestId('session-worktree-dialog')).toBeVisible();
  await expect(page.getByTestId('session-card-s1')).toHaveAttribute('data-active', 'true');
});
