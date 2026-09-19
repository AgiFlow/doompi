import { expect, test } from '../support/cockpit';

// A cockpit nobody has started a session in. The fixture's `cockpit.session`
// is sessions[0] and there is none, so nothing here may touch it.
test.use({ sessionCount: 0 });

test('says there is no session and offers the one thing there is to do', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);

  await expect(page.getByTestId('welcome')).toBeVisible();
  await expect(page.getByTestId('welcome')).toContainText('no session yet');

  // Nothing on screen addresses an agent that does not exist.
  await expect(page.getByTestId('composer-input')).toBeHidden();
  await expect(page.getByTestId('selection-bar')).toBeHidden();
  await expect(page.getByTestId('timeline-empty')).toBeHidden();

  // The top bar has no session name to show.
  await expect(page.getByTestId('session-title')).toBeHidden();

  // The fixture workspace remains visible even with no sessions.
  const workspace = page.locator('[data-testid^="workspace-group-"]');
  await expect(workspace).toBeVisible();
  await expect(workspace.locator('[data-testid^="workspace-new-session-"]')).toBeVisible();
});

test('routes onboarding through workspace admission and workspace-scoped sessions', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await expect(page.getByTestId('welcome')).toBeVisible();
  const workspace = page.locator('[data-testid^="workspace-group-"]');
  await expect(workspace).toBeVisible();

  await page.getByTestId('welcome-new-session').click();
  await expect(page.getByTestId('add-workspace-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('add-workspace-dialog')).toBeHidden();

  await page.keyboard.press('Control+t');
  await expect(page.getByTestId('new-session-dialog')).toBeVisible();
  await page.keyboard.press('Escape');

  await workspace.locator('[data-testid^="workspace-new-session-"]').click();
  await expect(page.getByTestId('new-session-dialog')).toBeVisible();
});

test('starting a session hands the column back to the conversation', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  const workspace = page.locator('[data-testid^="workspace-group-"]');
  await expect(workspace).toBeVisible();

  await workspace.locator('[data-testid^="workspace-new-session-"]').click();
  await expect(page.getByTestId('new-session-dialog')).toBeVisible();
  await page.getByTestId('new-session-create').click();

  await expect(page).toHaveURL(/\/session\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  await expect(page.getByTestId('welcome')).toBeHidden();
  await expect(page.getByTestId('composer-input')).toBeVisible();
});
