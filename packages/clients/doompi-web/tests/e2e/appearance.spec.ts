import { expect, test } from '../support/cockpit.ts';

/** What every surface is coloured from; reading it proves a theme actually landed. */
const BACKGROUND = '--doom-bg';

/** Runs in the page, so the token comes in as an argument rather than a closure. */
const readToken = (token: string): string => getComputedStyle(document.documentElement).getPropertyValue(token).trim();

test('ships the dark theme by default and names it on the root', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'doom-one-dark');
  expect(await page.evaluate(readToken, BACKGROUND)).toBe('#282c34');
});

test('switches the whole cockpit to another theme and remembers it', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await page.getByTestId('settings-open').click();
  await page.getByTestId('settings-section-appearance').click();
  await expect(page.getByTestId('appearance-settings')).toBeVisible();
  await expect(page.getByTestId('theme-doom-one-dark')).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('theme-doom-one-light').click();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'doom-one-light');
  expect(await page.evaluate(readToken, BACKGROUND)).toBe('#fafafa');
  // The derived tokens follow the palette even though the light theme pins none.
  expect(await page.evaluate(readToken, '--doom-tint-blue')).toContain('color-mix');
  await expect(page.getByTestId('theme-doom-one-light')).toHaveAttribute('data-selected', 'true');

  // The choice is the browser's, so it survives a reload with no session involved.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'doom-one-light');
  expect(await page.evaluate(readToken, BACKGROUND)).toBe('#fafafa');
});

test('falls back to the shipped theme when the stored name is unknown', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await page.evaluate(() => window.localStorage.setItem('doompi.web.theme', 'a-theme-that-was-removed'));
  await page.reload();
  await cockpit.session.waitForAttach();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'doom-one-dark');
  // The unusable preference is forgotten rather than retried on every load.
  expect(await page.evaluate(() => window.localStorage.getItem('doompi.web.theme'))).toBeNull();
});
