import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '../support/cockpit.ts';

const COMMANDS = {
  type: 'response',
  command: 'get_commands',
  data: {
    commands: [
      { name: 'mode', description: 'switch the major mode' },
      { name: 'model', description: 'pick the agent model' },
      { name: 'profile', description: 'switch the profile' },
    ],
  },
};

/** The fake session's real working directory, read from its registry record. */
function sessionCwd(registryDir: string, sessionId: string): string {
  const record = JSON.parse(fs.readFileSync(path.join(registryDir, 'sessions', `${sessionId}.json`), 'utf8')) as {
    cwd: string;
  };
  return record.cwd;
}

test('the input grows with a multi-line draft instead of hiding it', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  const input = page.getByTestId('composer-input');
  await input.waitFor();
  const singleLine = (await input.boundingBox())?.height ?? 0;

  await input.fill('first line\nsecond line\nthird line\nfourth line');
  const grown = (await input.boundingBox())?.height ?? 0;
  expect(grown).toBeGreaterThan(singleLine * 2);

  // Clearing shrinks it back to one line.
  await input.fill('');
  const cleared = (await input.boundingBox())?.height ?? 0;
  expect(cleared).toBeLessThan(singleLine * 1.5);
});

test('typing / completes the session commands', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_commands');
  cockpit.session.emit(COMMANDS);

  const input = page.getByTestId('composer-input');
  await input.fill('/mo');
  await expect(page.getByTestId('composer-completion')).toBeVisible();
  await expect(page.getByTestId('composer-completion-item-0')).toContainText('/mode');
  await expect(page.getByTestId('composer-completion-item-1')).toContainText('/model');

  await input.press('ArrowDown');
  await input.press('Tab');
  await expect(input).toHaveValue('/model ');
  await expect(page.getByTestId('composer-completion')).toBeHidden();

  // Enter now sends the completed command as a prompt.
  await input.press('Enter');
  const prompt = await cockpit.session.waitForCommand('prompt');
  expect(prompt.message).toBe('/model');
});

test('typing @ completes files from the session working directory', async ({ page, cockpit }) => {
  const cwd = sessionCwd(cockpit.registryDir, cockpit.session.id);
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'gateKeeper.ts'), '');
  fs.writeFileSync(path.join(cwd, 'notes.md'), '');

  await page.goto(cockpit.url);
  const input = page.getByTestId('composer-input');
  await input.fill('look at @gate');
  await expect(page.getByTestId('composer-completion')).toBeVisible();
  await expect(page.getByTestId('composer-completion-item-0')).toContainText('@src/gateKeeper.ts');

  await input.press('Enter');
  await expect(input).toHaveValue('look at @src/gateKeeper.ts ');
  await expect(page.getByTestId('composer-completion')).toBeHidden();

  // Escape closes the popup without touching the draft.
  await input.fill('look at @notes');
  await expect(page.getByTestId('composer-completion')).toBeVisible();
  await input.press('Escape');
  await expect(page.getByTestId('composer-completion')).toBeHidden();
  await expect(input).toHaveValue('look at @notes');
});

test('clicking outside the popup closes it', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_commands');
  cockpit.session.emit(COMMANDS);

  const input = page.getByTestId('composer-input');
  await input.fill('/mo');
  await expect(page.getByTestId('composer-completion')).toBeVisible();
  await page.getByTestId('top-bar').click();
  await expect(page.getByTestId('composer-completion')).toBeHidden();
  await expect(input).toHaveValue('/mo');
});

test('enter sends a command that is already complete instead of completing it again', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await cockpit.session.waitForCommand('get_commands');
  cockpit.session.emit({
    type: 'response',
    command: 'get_commands',
    success: true,
    data: {
      commands: [
        { name: 'profile', description: 'select a profile' },
        { name: 'profiles', description: 'list every profile' },
      ],
    },
  });

  const input = page.getByTestId('composer-input');
  await input.click();
  await input.pressSequentially('/profile');
  await expect(page.getByTestId('composer-completion')).toBeVisible();

  // '/profile' is already the highlighted command, so completing would only
  // add a space; the keystroke sends instead of looking like it did nothing.
  await input.press('Enter');

  const sent = await cockpit.session.waitForCommand('prompt');
  expect(sent.message).toBe('/profile');
  await expect(input).toHaveValue('');
});

test('enter still completes a command the draft has only started', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await cockpit.session.waitForCommand('get_commands');
  cockpit.session.emit({
    type: 'response',
    command: 'get_commands',
    success: true,
    data: { commands: [{ name: 'profile', description: 'select a profile' }] },
  });

  const input = page.getByTestId('composer-input');
  await input.click();
  await input.pressSequentially('/pro');
  await expect(page.getByTestId('composer-completion')).toBeVisible();

  await input.press('Enter');

  await expect(input).toHaveValue('/profile ');
  await expect(page.getByTestId('composer-completion')).toBeHidden();
});

test('attaches image payloads and inlines removable text files', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  const picker = page.getByTestId('composer-file-input');

  await picker.setInputFiles({ name: 'huge.txt', mimeType: 'text/plain', buffer: Buffer.alloc(100 * 1024 + 1) });
  await expect(page.getByTestId('composer-attachment-error')).toContainText('exceeds the 100 KB text file limit');
  await picker.setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: Buffer.from('image bytes') });
  await expect(page.getByTestId('composer-attachments')).toContainText('screen.png');

  await picker.setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('check the retry path'),
  });
  await expect(page.getByTestId('composer-attachments')).toContainText('notes.txt');
  await page.getByRole('button', { name: 'remove notes.txt' }).click();
  await expect(page.getByTestId('composer-attachments')).not.toContainText('notes.txt');

  await picker.setInputFiles({
    name: 'details.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('expected behavior'),
  });
  await page.getByTestId('composer-input').fill('Review these');
  await page.getByTestId('composer-send').click();

  const sentImage = page.getByTestId('user-attached-image');
  await expect(sentImage).toBeVisible();
  await expect(sentImage).toHaveAttribute(
    'src',
    `data:image/png;base64,${Buffer.from('image bytes').toString('base64')}`,
  );

  const prompt = await cockpit.session.waitForCommand('prompt');
  expect(prompt.message).toBe('Review these\n\nAttached file "details.md":\n\nexpected behavior');
  expect(prompt.images).toEqual([
    { type: 'image', data: Buffer.from('image bytes').toString('base64'), mimeType: 'image/png' },
  ]);
  await expect(page.getByTestId('composer-attachments')).toBeHidden();
});
