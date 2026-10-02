import type { Page } from '@playwright/test';

import { expect, test } from '../support/cockpit';

// The workspace is a git repository: main (checked out), feature/existing, and
// remote-only on origin. doompi-git replaces the host's new-session dialog.
test.use({ gitWorkspace: true });

async function openDialog(page: Page, url: string): Promise<void> {
  await page.goto(url);
  const workspace = page.locator('[data-testid^="workspace-group-"]').first();
  await workspace.locator('[data-testid^="workspace-new-session-"]').click();
  await expect(page.getByTestId('new-session-dialog')).toBeVisible();
  await expect(page.getByTestId('git-new-session-mode-existing')).toBeVisible();
}

function branchOption(page: Page, name: string, remote?: string) {
  const option = page.locator(`[data-testid="git-new-session-branch-option"][data-branch="${name}"]`);
  return remote === undefined
    ? option.and(page.locator(':not([data-remote])'))
    : option.and(page.locator(`[data-remote="${remote}"]`));
}

test('lists local then remote-only branches and disables the checked-out one', async ({ page, cockpit }) => {
  await openDialog(page, cockpit.url);

  await expect(branchOption(page, 'main')).toBeDisabled();
  await expect(branchOption(page, 'feature/existing')).toBeEnabled();
  await expect(branchOption(page, 'remote-only', 'origin')).toBeEnabled();
  await expect(page.getByTestId('new-session-create')).toBeDisabled();

  await page.getByTestId('git-new-session-branch-search').fill('remote');
  await expect(page.getByTestId('git-new-session-branch-option')).toHaveCount(1);
});

test('opens an existing branch as a top-level worktree session', async ({ page, cockpit }) => {
  await openDialog(page, cockpit.url);
  const before = page.url();

  await branchOption(page, 'feature/existing').click();
  await page.getByTestId('new-session-create').click();

  await expect(page.getByTestId('new-session-dialog')).toBeHidden({ timeout: 60_000 });
  await expect(page).not.toHaveURL(before);
  await cockpit.sessions[1]!.waitForAttach();
  const card = page.locator('[data-testid^="session-card-"]', { hasText: 'feature/existing' });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-nested', 'false');

  const changes = page.getByTestId('activity-git').getByTestId('activity-diff-changes');
  await expect(changes).toContainText('feature/existing');
  await expect(changes).toHaveAttribute(
    'aria-label',
    'review feature/existing changes: 0 added, 0 removed vs origin/main',
  );
  await expect(page.getByTestId('activity-diff')).toHaveCount(0);
  await changes.click();
  await expect(page.getByTestId('git-review-empty')).toBeVisible();
});

test('tracks a remote-only branch in its worktree', async ({ page, cockpit }) => {
  await openDialog(page, cockpit.url);

  await branchOption(page, 'remote-only', 'origin').click();
  await page.getByTestId('new-session-name').fill('from origin');
  await page.getByTestId('new-session-create').click();

  await expect(page.getByTestId('new-session-dialog')).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('[data-testid^="session-card-"]', { hasText: 'from origin' })).toBeVisible();
});

test('starts a new branch from the default base', async ({ page, cockpit }) => {
  await openDialog(page, cockpit.url);

  await page.getByTestId('git-new-session-mode-new').click();
  await expect(page.getByTestId('git-new-session-base')).toContainText('origin/main');
  await page.getByTestId('git-new-session-new-branch').fill('feature/fresh');
  await page.getByTestId('new-session-create').click();

  await expect(page.getByTestId('new-session-dialog')).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('[data-testid^="session-card-"]', { hasText: 'feature/fresh' })).toBeVisible();
});
