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

test('lists the commands the session reports', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_commands');
  cockpit.session.emit(COMMANDS);

  await page.keyboard.press('Control+k');

  await expect(page.getByTestId('palette')).toBeVisible();
  // Groups are keyed by first letter, the way Leader Space's prefix map is.
  await expect(page.getByTestId('palette-item-0')).toContainText('domains');
  await expect(page.getByTestId('palette-count')).toHaveText('4');
  await expect(page.getByTestId('palette-sub-domains')).toBeVisible();
});

test('filters and invokes a command as a slash prompt', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_commands');
  cockpit.session.emit(COMMANDS);

  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-filter').fill('dom');
  await expect(page.getByTestId('palette-count')).toHaveText('1');

  await page.getByTestId('palette-sub-domains').click();

  const sent = await cockpit.session.waitForCommand('prompt');
  expect(sent.message).toBe('/domains');
  await expect(page.getByTestId('palette')).toBeHidden();
});

test('says so when the session reports no commands', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_commands');
  cockpit.session.emit({ type: 'response', command: 'get_commands', success: true, data: { commands: [] } });

  await page.keyboard.press('Control+k');

  await expect(page.getByTestId('palette-empty')).toBeVisible();
});

test('escape closes the palette', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_commands');
  cockpit.session.emit(COMMANDS);

  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette')).toBeHidden();
});
