import { expect, test } from '../support/cockpit.ts';

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

  // The rail is still the rail, with its own way in.
  await expect(page.getByTestId('new-session-empty')).toBeVisible();
});

test('the panel and ctrl+t open the same dialog the rail opens', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await expect(page.getByTestId('welcome')).toBeVisible();

  await page.getByTestId('welcome-new-session').click();
  await expect(page.getByTestId('new-session-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('new-session-dialog')).toBeHidden();

  await page.keyboard.press('Control+t');
  await expect(page.getByTestId('new-session-dialog')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByTestId('new-session-open').click();
  await expect(page.getByTestId('new-session-dialog')).toBeVisible();
});

test('starting a session hands the column back to the conversation', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await page.getByTestId('welcome-new-session').click();
  // With no session there is nothing to prefill the directory from, and the
  // registering stand-in needs a real directory that is not the hub's own.
  await page.getByTestId('new-session-cwd').fill(process.cwd());
  await page.getByTestId('new-session-create').click();

  await expect(page).toHaveURL(/\/session\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  await expect(page.getByTestId('welcome')).toBeHidden();
  await expect(page.getByTestId('composer-input')).toBeVisible();
});
