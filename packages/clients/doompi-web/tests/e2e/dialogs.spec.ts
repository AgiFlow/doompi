import { expect, test } from '../support/cockpit.ts';

test('answers a select request, the shape a permission prompt uses', async ({ page, cockpit }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await page.getByTestId('mobile-activity-open').click();
  await expect(page.getByTestId('activity-dock')).toBeVisible();

  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'req-1',
    method: 'select',
    title: 'permission required',
    message: 'pi wants to run rm -rf node_modules/.cache',
    options: ['allow once', 'allow for this session', 'deny'],
  });

  const dialog = page.getByTestId('dialog');
  await expect(dialog).toHaveAttribute('data-dialog-method', 'select');
  await expect(page.getByTestId('activity-dock')).toBeHidden();
  await expect(page.getByTestId('dialog-title')).toHaveText('permission required');
  await expect(page.getByTestId('dialog-message')).toContainText('rm -rf node_modules/.cache');

  await page.getByTestId('dialog-option-0').click();

  const answer = await cockpit.session.waitForCommand('extension_ui_response');
  expect(answer.id).toBe('req-1');
  expect(answer.value).toBe('allow once');
  await expect(dialog).toBeHidden();

  // The backlog replays the request, but the hub recorded the answer, so a
  // reload must not reopen a dialog nobody is waiting on.
  await page.reload();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(dialog).toBeHidden();
});

test('an unanswered dialog survives a reload', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'req-pending',
    method: 'select',
    title: 'still waiting',
    options: ['a', 'b'],
  });
  await expect(page.getByTestId('dialog')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('dialog')).toBeVisible();
  await expect(page.getByTestId('dialog-title')).toHaveText('still waiting');
});

test('answers a confirm request', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'req-2',
    method: 'confirm',
    title: 'Clear session?',
    message: 'All messages will be lost.',
  });

  await page.getByTestId('dialog-confirm').click();

  const answer = await cockpit.session.waitForCommand('extension_ui_response');
  expect(answer.id).toBe('req-2');
  expect(answer.confirmed).toBe(true);
});

test('answers an input request', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'req-3',
    method: 'input',
    title: 'Enter a value',
    placeholder: 'type something…',
  });

  await page.getByTestId('dialog-input').fill('golden fixture');
  await page.getByTestId('dialog-submit').click();

  const answer = await cockpit.session.waitForCommand('extension_ui_response');
  expect(answer.id).toBe('req-3');
  expect(answer.value).toBe('golden fixture');
});

test('cancelling tells the agent instead of stranding it', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'req-4',
    method: 'select',
    title: 'pick',
    options: ['a', 'b'],
  });
  // Wait for the overlay to take focus, otherwise the key lands on the page.
  await expect(page.getByTestId('dialog')).toBeVisible();
  await page.keyboard.press('Escape');

  const answer = await cockpit.session.waitForCommand('extension_ui_response');
  expect(answer.id).toBe('req-4');
  expect(answer.cancelled).toBe(true);
  await expect(page.getByTestId('dialog')).toBeHidden();
});

test('a long option list is reachable from the keyboard past the ninth', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  const options = Array.from({ length: 21 }, (_, index) => `profile-${String(index + 1).padStart(2, '0')}`);
  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'many',
    method: 'select',
    title: 'Profile',
    options,
  });

  await expect(page.getByTestId('dialog')).toBeVisible();
  // Only nine options can carry a digit, so the hint stops promising more.
  await expect(page.getByTestId('dialog-hints')).toContainText('up/down move');
  await expect(page.getByTestId('dialog-option-0')).toHaveAttribute('data-cursor', 'true');

  // Eleven presses walk past the digit shortcuts to the twelfth option.
  for (let step = 0; step < 11; step += 1) await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('dialog-option-11')).toHaveAttribute('data-cursor', 'true');

  await page.keyboard.press('Enter');
  const answer = await cockpit.session.waitForCommand('extension_ui_response');
  expect(answer.value).toBe('profile-12');
});

test('the digit shortcuts still answer a short list', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'few',
    method: 'select',
    title: 'Flavor',
    options: ['Normal', 'Debug', 'Fable'],
  });

  await expect(page.getByTestId('dialog-hints')).toContainText('1-9 select');
  await page.keyboard.press('3');

  const answer = await cockpit.session.waitForCommand('extension_ui_response');
  expect(answer.value).toBe('Fable');
});
