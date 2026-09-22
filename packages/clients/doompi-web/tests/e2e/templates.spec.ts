import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from '../support/cockpit';

const ADVANCED = 'doompi-template-advanced';
const ELEGANT = 'doompi-template-elegant';

test.use({ assets: 'synced' });

interface TemplateStartupHistory {
  templates: string[];
  diagnostics: string[];
}

async function recordTemplateStartup(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const history: TemplateStartupHistory = { templates: [], diagnostics: [] };
    (window as unknown as { templateStartupHistory: TemplateStartupHistory }).templateStartupHistory = history;
    new MutationObserver(() => {
      const template = document.querySelector('[data-template]')?.getAttribute('data-template');
      if (template && template !== 'loading' && history.templates.at(-1) !== template) history.templates.push(template);
      const diagnostic = document.querySelector('[data-testid="template-diagnostic"]')?.textContent;
      if (diagnostic && history.diagnostics.at(-1) !== diagnostic) history.diagnostics.push(diagnostic);
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-template'] });
  });
}

async function expectFirstTemplate(page: Page, id: string): Promise<void> {
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', id);
  expect(
    await page.evaluate(
      () => (window as unknown as { templateStartupHistory: TemplateStartupHistory }).templateStartupHistory,
    ),
  ).toEqual({ templates: [id], diagnostics: [] });
}
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

test('uses Advanced for global Settings by default, including a cold appearance reload', async ({
  context,
  cockpit,
}) => {
  const page = await context.newPage();
  await recordTemplateStartup(page);
  await page.goto(`${cockpit.url}/settings/providers`, { waitUntil: 'domcontentloaded' });
  await expectFirstTemplate(page, ADVANCED);
  await expect(page.getByTestId('session-rail-panel')).toBeVisible();
  await page.getByTestId('settings-section-appearance').click();
  await expect(page.getByTestId(`template-${ADVANCED}`)).toBeVisible();
  await expectFirstTemplate(page, ADVANCED);
  await page.reload();
  await expectFirstTemplate(page, ADVANCED);
  await expect(page.getByTestId('session-rail-panel')).toBeVisible();
});
for (const template of [ADVANCED, ELEGANT]) {
  test(`first renders ${template} only after composition and configuration are ready`, async ({ context, cockpit }) => {
    // Use an unwrapped page so the fixture's interaction gate cannot conceal startup rendering.
    const page = await context.newPage();
    const file = path.join(path.dirname(cockpit.agentDir), '.pi', '.doom', 'config.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `web:\n  template: ${template}\n`);
    await recordTemplateStartup(page);
    let releaseComposition!: () => void;
    let releaseConfiguration!: () => void;
    const compositionGate = new Promise<void>((resolve) => {
      releaseComposition = resolve;
    });
    const configurationGate = new Promise<void>((resolve) => {
      releaseConfiguration = resolve;
    });
    let compositionRequested = false;
    await page.route('**/api/compositions', async (route) => {
      compositionRequested = true;
      await compositionGate;
      await route.continue();
    });
    await page.route(
      (url) => url.pathname.endsWith('/settings') && url.searchParams.has('key'),
      async (route) => {
        await configurationGate;
        await route.continue();
      },
    );
    try {
      await page.goto(cockpit.url, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => compositionRequested).toBe(true);
      await expect(page.getByTestId('template-loading')).toBeVisible();
      await expect(page.getByTestId('template-diagnostic')).toHaveCount(0);
      await expect(page.getByTestId('template-recovery')).toHaveCount(0);
      releaseComposition();
      await page
        .locator('link[data-doompi-plugin-composition][media="all"]')
        .nth(cockpit.pluginStyleCount - 1)
        .waitFor({ state: 'attached' });
      await expect(page.getByTestId('template-loading')).toBeVisible();
      await expect(page.getByTestId('composer-input')).toHaveCount(0);
      releaseConfiguration();
      await expectFirstTemplate(page, template);
      await expect(page.getByTestId('composer-input')).toBeVisible();
      await page.reload();
      await expectFirstTemplate(page, template);
    } finally {
      releaseComposition();
      releaseConfiguration();
    }
  });
}

for (const entry of ['landing', 'deep-link']) {
  test(`waits for ${entry} session scope before rendering its workspace template`, async ({ context, cockpit }) => {
    const page = await context.newPage();
    const configFile = path.join(path.dirname(cockpit.teamTemp), 'workspaces', '.doom', 'config.yaml');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, `web:\n  template: ${ELEGANT}\n`);
    await recordTemplateStartup(page);
    const releaseSockets: Array<() => void> = [];
    await page.routeWebSocket(/.*/, (socket) => {
      const server = socket.connectToServer();
      const messages: Array<string | Buffer> = [];
      let held = true;
      server.onMessage((message) => {
        if (held) messages.push(message);
        else socket.send(message);
      });
      releaseSockets.push(() => {
        held = false;
        for (const message of messages.splice(0)) socket.send(message);
      });
    });
    try {
      await page.goto(entry === 'landing' ? cockpit.url : `${cockpit.url}/session/${cockpit.session.id}`);
      await page.locator('link[data-doompi-plugin-composition][media="all"]').first().waitFor({ state: 'attached' });
      await expect.poll(() => releaseSockets.length).toBeGreaterThan(0);
      await expect(page.getByTestId('template-loading')).toBeVisible();
      await expect(page.getByTestId('template-diagnostic')).toHaveCount(0);
      for (const release of releaseSockets) release();
      await expectFirstTemplate(page, ELEGANT);
      await expect(page.getByTestId('composer-input')).toBeVisible();
    } finally {
      for (const release of releaseSockets) release();
    }
  });
}

for (const resource of ['compositions', 'settings']) {
  test(`reports ${resource} bootstrap failure and retries without a stuck loading screen`, async ({
    context,
    cockpit,
  }) => {
    const page = await context.newPage();
    let failing = true;
    await page.route(
      (url) => url.pathname === `/api/${resource}`,
      async (route) => {
        if (failing) await route.fulfill({ status: 503, json: { error: 'Bootstrap temporarily unavailable' } });
        else await route.continue();
      },
    );
    await page.goto(`${cockpit.url}/settings/appearance`);
    await expect(page.getByTestId('template-diagnostic')).toContainText(
      resource === 'compositions' ? '503' : 'Bootstrap temporarily unavailable',
    );
    await expect(page.getByTestId('template-loading')).toHaveCount(0);
    await expect(page.getByTestId('template-diagnostic')).not.toContainText('No compatible');
    await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ADVANCED);
    failing = false;
    await page.getByRole('button', { name: 'Retry templates' }).click();
    await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ADVANCED);
    await expect(page.getByTestId('template-diagnostic')).toHaveCount(0);
  });
}

test('renders Advanced when composition bootstrap fails while template configuration is pending', async ({
  context,
  cockpit,
}) => {
  const page = await context.newPage();
  let releaseConfiguration!: () => void;
  const configurationGate = new Promise<void>((resolve) => {
    releaseConfiguration = resolve;
  });
  await page.route('**/api/compositions', (route) =>
    route.fulfill({ status: 503, json: { error: 'Composition temporarily unavailable' } }),
  );
  await page.route(
    (url) => url.pathname.endsWith('/settings') && url.searchParams.has('key'),
    async (route) => {
      await configurationGate;
      await route.continue();
    },
  );
  try {
    await page.goto(`${cockpit.url}/settings/appearance`);
    await expect(page.getByTestId('template-diagnostic')).toContainText('503');
    await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ADVANCED);
  } finally {
    releaseConfiguration();
  }
});
