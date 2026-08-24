import { expect, test } from '../support/cockpit.ts';

const status = (statusKey: string, statusText?: string) => ({
  type: 'extension_ui_request',
  id: `st-${statusKey}-${Math.random()}`,
  method: 'setStatus',
  statusKey,
  ...(statusText === undefined ? {} : { statusText }),
});

const widget = (widgetKey: string) => ({
  type: 'extension_ui_request',
  id: `wg-${widgetKey}`,
  method: 'setWidget',
  widgetKey,
});

test('says nothing is supervised when the composition loads no such packages', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await expect(page.getByTestId('activity-dock')).toBeVisible();
  await expect(page.getByTestId('activity-empty')).toBeVisible();
});

test('lists the groups this composition actually loaded', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-team-agents'));
  cockpit.session.emit(status('doom-runner-runners'));
  cockpit.session.emit(widget('workflow-mcp-progress'));

  await expect(page.getByTestId('activity-agents')).toBeVisible();
  await expect(page.getByTestId('activity-runners')).toBeVisible();
  await expect(page.getByTestId('activity-workflows')).toBeVisible();
  await expect(page.getByTestId('activity-summary-agents')).toHaveText('idle');
});

test('surfaces what a busy group reports', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-runner-runners', '2 runners · pnpm dev'));

  await expect(page.getByTestId('activity-runners')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('activity-summary-runners')).toHaveText('2 runners · pnpm dev');
  await expect(page.getByTestId('activity-busy')).toHaveText('1 running');
});

test('opens the group with the command the TUI uses', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-runner-runners', '1 runner'));
  await page.getByTestId('activity-open-runners').click();

  const sent = await cockpit.session.waitForCommand('prompt');
  expect(sent.message).toBe('/runners');
});

test('the dock can be hidden and brought back', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await page.getByTestId('activity-close').click();
  await expect(page.getByTestId('activity-dock')).toBeHidden();

  await page.getByTestId('activity-show').click();
  await expect(page.getByTestId('activity-dock')).toBeVisible();
});
