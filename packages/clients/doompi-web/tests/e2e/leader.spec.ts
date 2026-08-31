import { expect, test } from '../support/cockpit.ts';

const COMMANDS = {
  type: 'response',
  command: 'get_commands',
  success: true,
  data: {
    commands: [
      { name: 'mode', description: 'pick a major mode' },
      { name: 'domains', description: 'switch the active domains' },
      { name: 'profile', description: 'select a profile' },
      { name: 'tools', description: 'open the tool inventory' },
    ],
  },
};

test.describe('with the package bundle, which installs no plugins', () => {
  test('says so when no package registered leader keys', async ({ page, cockpit }) => {
    await page.goto(cockpit.url);
    await cockpit.session.waitForCommand('get_commands');
    cockpit.session.emit(COMMANDS);

    await page.keyboard.press('Control+k');

    await expect(page.getByTestId('palette')).toBeVisible();
    await expect(page.getByTestId('palette-empty')).toBeVisible();
    await expect(page.getByTestId('palette-count')).toHaveText('0');
  });

  test('slash searches the commands the session reports and runs one as a slash prompt', async ({ page, cockpit }) => {
    await page.goto(cockpit.url);
    await cockpit.session.waitForCommand('get_commands');
    cockpit.session.emit(COMMANDS);

    await page.keyboard.press('Control+k');
    await page.keyboard.press('/');
    await expect(page.getByTestId('palette-filter')).toBeFocused();
    await page.keyboard.type('dom');
    await expect(page.getByTestId('palette-count')).toHaveText('1');

    await page.getByTestId('palette-sub-domains').click();

    const sent = await cockpit.session.waitForCommand('prompt');
    expect(sent.message).toBe('/domains');
    await expect(page.getByTestId('palette')).toBeHidden();
  });

  test('enter runs the top search match', async ({ page, cockpit }) => {
    await page.goto(cockpit.url);
    await cockpit.session.waitForCommand('get_commands');
    cockpit.session.emit(COMMANDS);

    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('palette')).toBeVisible();
    await page.keyboard.press('/');
    await expect(page.getByTestId('palette-filter')).toBeFocused();
    await page.keyboard.type('pro');
    await expect(page.getByTestId('palette-count')).toHaveText('1');
    await page.keyboard.press('Enter');

    const sent = await cockpit.session.waitForCommand('prompt');
    expect(sent.message).toBe('/profile');
  });

  test('escape closes the palette, and space in an empty composer opens it', async ({ page, cockpit }) => {
    await page.goto(cockpit.url);
    await cockpit.session.waitForCommand('get_commands');
    cockpit.session.emit(COMMANDS);

    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('palette')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('palette')).toBeHidden();

    await page.getByTestId('composer-input').focus();
    await page.keyboard.press(' ');
    await expect(page.getByTestId('palette')).toBeVisible();
    await page.keyboard.press('Escape');

    // With a draft in progress, space is a space.
    await page.getByTestId('composer-input').fill('hello');
    await page.keyboard.press(' ');
    await expect(page.getByTestId('palette')).toBeHidden();
    await expect(page.getByTestId('composer-input')).toHaveValue('hello ');
  });
});

test.describe('with the synced bundle, whose plugins declare leader keys', () => {
  test.use({ assets: 'synced' });

  test('keys walk the plugin tree: SPC w r opens the workflows tab', async ({ page, cockpit }) => {
    await page.goto(cockpit.url);
    await cockpit.session.waitForCommand('get_commands');
    cockpit.session.emit(COMMANDS);

    await page.keyboard.press('Control+k');
    // Root: the groups the installed plugins declared, sorted by key. The
    // bundle's plugin set decides how many sit between them, so only the
    // first and the workflows group are pinned.
    await expect(page.getByTestId('palette-item-0')).toHaveAttribute('data-key', 'a');
    await expect(page.locator('[data-testid^="palette-item-"][data-key="w"]')).toHaveCount(1);

    await page.keyboard.press('w');
    await expect(page.getByTestId('palette')).toHaveAttribute('data-path', 'w');
    await expect(page.getByTestId('palette-path')).toContainText('workflows');
    await expect(page.getByTestId('palette-item-0')).toHaveAttribute('data-key', 'e');
    await expect(page.getByTestId('palette-item-1')).toHaveAttribute('data-key', 'l');
    await expect(page.getByTestId('palette-item-2')).toHaveAttribute('data-key', 'r');

    // Backspace climbs, then the same key descends again.
    await page.keyboard.press('Backspace');
    await expect(page.getByTestId('palette')).toHaveAttribute('data-path', '');
    await page.keyboard.press('w');
    await page.keyboard.press('r');

    await expect(page.getByTestId('palette')).toBeHidden();
    await expect(page).toHaveURL(/\/workflows$/);
  });

  test('a command leaf runs as a slash prompt: SPC w e toggles workflow mode', async ({ page, cockpit }) => {
    await page.goto(cockpit.url);
    await cockpit.session.waitForCommand('get_commands');
    cockpit.session.emit(COMMANDS);

    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('palette')).toBeVisible();
    await page.keyboard.press('w');
    await expect(page.getByTestId('palette')).toHaveAttribute('data-path', 'w');
    await page.keyboard.press('e');

    const sent = await cockpit.session.waitForCommand('prompt');
    expect(sent.message).toBe('/minor workflow');
    await expect(page.getByTestId('palette')).toBeHidden();
  });

  test('an unbound key is ignored rather than typed into the search', async ({ page, cockpit }) => {
    await page.goto(cockpit.url);
    await cockpit.session.waitForCommand('get_commands');
    cockpit.session.emit(COMMANDS);

    await page.keyboard.press('Control+k');
    await page.keyboard.press('z');
    await expect(page.getByTestId('palette')).toHaveAttribute('data-path', '');
    await expect(page.getByTestId('palette-filter')).toHaveValue('');
  });

  test('SPC a r opens the subagents tab', async ({ page, cockpit }) => {
    await page.goto(cockpit.url);
    await cockpit.session.waitForCommand('get_commands');
    cockpit.session.emit(COMMANDS);

    await page.keyboard.press('Control+k');
    await page.keyboard.press('a');
    await page.keyboard.press('r');
    await expect(page).toHaveURL(/\/subagents$/);
  });

  test('closing the palette hands the keyboard back to the composer', async ({ page, cockpit }) => {
    await page.goto(cockpit.url);
    await cockpit.session.waitForAttach();

    await page.getByTestId('composer-input').click();
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('palette')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('palette')).toBeHidden();

    // Opened by a shortcut, so nothing on the page can restore focus for it:
    // the caret has to be handed back, or the next keystroke goes nowhere.
    await expect(page.getByTestId('composer-input')).toBeFocused();
    await page.keyboard.type('still typing');
    await expect(page.getByTestId('composer-input')).toHaveValue('still typing');
  });
});
