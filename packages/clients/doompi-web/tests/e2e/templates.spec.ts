import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from '../support/cockpit';

const ADVANCED = 'doompi-template-advanced';
const ELEGANT = 'doompi-template-elegant';

test.use({ assets: 'synced' });

async function openAppearance(page: Page): Promise<void> {
  if (!(await page.getByTestId('settings-open').isVisible())) {
    await page.getByTestId('mobile-sessions-open').click();
  }
  await page.getByTestId('settings-open').click();
  await page.getByTestId('settings-section-appearance').click();
  await expect(page.getByTestId('template-settings')).toBeVisible();
}

async function saveChoice(page: Page, id: string, verifySelection = true): Promise<void> {
  await page.getByTestId(`template-${id}`).click();
  await page.getByTestId('template-save').click();
  if (verifySelection) await expect(page.getByTestId('template-origin')).toContainText(id);
  await expect(page.getByTestId('template-save-error')).toBeHidden();
}

async function workspaceScope(page: Page): Promise<void> {
  await page.getByTestId('template-scope').click();
  await page
    .getByRole('option', { name: /^Workspace:/ })
    .first()
    .click();
}

test('changes packages without losing a draft, attachment, or streaming session, and persists the default', async ({
  page,
  cockpit,
}, testInfo) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ADVANCED);
  await page.getByTestId('composer-attach').click();
  await page
    .getByTestId('composer-file-input')
    .setInputFiles({ name: 'retained.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this attachment') });
  await expect(page.getByTestId('composer-attachments')).toContainText('retained.txt');
  await page.getByTestId('composer-input').fill('Keep this draft across templates');
  cockpit.session.emit({ type: 'agent_start' });
  cockpit.session.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'Before template change. ' },
  });
  await expect(page.getByTestId('entry-assistant')).toContainText('Before template change.');
  await page.screenshot({ path: testInfo.outputPath('advanced.png') });
  await openAppearance(page);
  await saveChoice(page, ELEGANT);
  cockpit.session.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'After template change.' },
  });
  await page.getByTestId('settings-close').click();
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ELEGANT);
  await expect(page.getByTestId('composer-input')).toHaveValue('Keep this draft across templates');
  await expect(page.getByTestId('composer-attachments')).toContainText('retained.txt');
  await expect(page.getByTestId('entry-assistant')).toContainText('Before template change. After template change.');
  await expect(page.getByTestId('composer-abort')).toBeVisible();
  await expect(page.getByTestId('session-rail-panel')).toBeHidden();
  await page.getByTestId('mobile-sessions-open').click();
  await expect(page.getByTestId('session-rail-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('session-rail-panel')).toBeHidden();
  await expect(page.getByTestId('mobile-sessions-open')).toBeFocused();
  await page.getByTestId('mobile-activity-open').click();
  await expect(page.getByTestId('activity-close')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('activity-close')).toBeHidden();
  await expect(page.getByTestId('mobile-activity-open')).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('elegant.png') });
  cockpit.session.emit({ type: 'agent_settled' });
  await page.reload();
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ELEGANT);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'doom-one-dark');
});

test('saves a workspace override and restores global inheritance', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await openAppearance(page);
  await saveChoice(page, ELEGANT);
  await workspaceScope(page);
  await expect(page.getByTestId('template-origin')).toContainText(`${ELEGANT} (global)`);
  await saveChoice(page, ADVANCED, false);
  await workspaceScope(page);
  await expect(page.getByTestId('template-origin')).toContainText(`${ADVANCED} (repository)`);
  await page.getByTestId('settings-close').click();
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ADVANCED);
  await openAppearance(page);
  await workspaceScope(page);
  await page.getByTestId('template-inherit').click();
  await workspaceScope(page);
  await expect(page.getByTestId('template-origin')).toContainText(`${ELEGANT} (global)`);
  await page.getByTestId('settings-close').click();
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ELEGANT);
});

test('keeps an unavailable configured identifier and falls back without locking out Settings', async ({
  page,
  cockpit,
}) => {
  const file = path.join(path.dirname(cockpit.agentDir), '.pi', '.doom', 'config.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'web:\n  template: no-longer-installed\n');
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ADVANCED);
  await expect(page.getByTestId('template-diagnostic')).toContainText('no-longer-installed');
  expect(fs.readFileSync(file, 'utf8')).toContain('no-longer-installed');
  await openAppearance(page);
  await saveChoice(page, ELEGANT);
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ELEGANT);
});

test('discovers an independent package without a host import', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await openAppearance(page);
  await saveChoice(page, 'independent-reader');
  await expect(page.getByTestId('independent-template')).toBeVisible();
  await expect(page.getByTestId('appearance-settings')).toBeVisible();
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('composer-input')).toHaveCount(1);
  await expect(page.getByTestId('independent-template')).toBeVisible();
});

test('recovers from a selected template render failure while retaining access to Settings', async ({
  page,
  cockpit,
}) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await openAppearance(page);
  await saveChoice(page, 'broken-reader');
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ADVANCED);
  await expect(page.getByTestId('template-diagnostic')).toContainText('broken-reader');
  await expect(page.getByTestId('template-settings')).toBeVisible();
  await saveChoice(page, ELEGANT);
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ELEGANT);
});
