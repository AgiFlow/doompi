import { expect, test } from '../support/cockpit.ts';

test('keeps the conversation full width and moves composition surfaces into mobile drawers', async ({
  page,
  cockpit,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await expect(page.getByTestId('session-rail-panel')).toBeHidden();
  await expect(page.getByTestId('activity-dock')).toBeHidden();
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByTestId('agent-model')).toHaveCSS('text-overflow', 'ellipsis');
  const modelBox = await page.getByTestId('axis-model').boundingBox();
  expect(modelBox).not.toBeNull();
  expect((modelBox?.x ?? 0) + (modelBox?.width ?? 0)).toBeLessThanOrEqual(390);

  await page.getByTestId('mobile-sessions-open').click();
  await expect(page.getByTestId('session-rail-panel')).toBeVisible();
  await expect(page.getByTestId('session-card-s1')).toBeVisible();
  await page.getByTestId('mobile-sessions-close').click();
  await expect(page.getByTestId('session-rail-panel')).toBeHidden();

  await page.getByTestId('mobile-activity-open').click();
  await expect(page.getByTestId('activity-dock')).toBeVisible();
  await page.getByTestId('activity-close').click();
  await expect(page.getByTestId('activity-dock')).toBeHidden();
});

test('stacks the settings navigation above contributed settings on a phone', async ({ page, cockpit }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await page.getByTestId('mobile-sessions-open').click();
  await page.getByTestId('settings-open').click();

  await expect(page.getByTestId('settings-menu')).toBeVisible();
  await expect(page.getByTestId('settings-content')).toBeVisible();
  await expect(page.getByTestId('session-rail-panel')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
