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

/** Observe inserted loading nodes too, so a brief mount cannot hide behind a later settled DOM. */
async function recordNavigationLoading(page: Page): Promise<void> {
  await page.evaluate(() => {
    const history = { loading: 0 };
    (window as unknown as { templateNavigationHistory: typeof history }).templateNavigationHistory = history;
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (
            node instanceof Element &&
            (node.matches('[data-testid="template-loading"]') || node.querySelector('[data-testid="template-loading"]'))
          )
            history.loading += 1;
    }).observe(document, { childList: true, subtree: true });
  });
}

async function expectNoNavigationLoading(page: Page): Promise<void> {
  await expect(page.getByTestId('template-loading')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { templateNavigationHistory: { loading: number } }).templateNavigationHistory.loading,
    ),
  ).toBe(0);
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test.describe(`template navigation at ${viewport.width}px`, () => {
    test.use({ sessionCount: 2, viewport });

    test('reuses the workspace layout while the next session composition is pending', async ({ context, cockpit }) => {
      const page = await context.newPage();
      await page.goto(`${cockpit.url}/session/s1`);
      await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ADVANCED);
      await page.getByTestId('composer-input').fill('draft for session one');
      if (viewport.width < 768) await page.getByTestId('mobile-sessions-open').click();
      const rail = await page.getByTestId('session-rail-panel').elementHandle();
      expect(rail).not.toBeNull();
      await recordNavigationLoading(page);
      const gate = cockpit.holdSessionComposition('s2');
      let requested = false;
      void gate.requested.then(() => {
        requested = true;
      });
      try {
        await page.getByTestId('session-open-s2').click();
        await expect.poll(() => requested).toBe(true);
        await expect(page.getByTestId('session-card-s2')).toHaveAttribute('data-active', 'true');
        await expect(page.getByTestId('composer-input')).toHaveValue('');
        expect(
          await rail!.evaluate(
            (element) =>
              element.isConnected && element === document.querySelector('[data-testid="session-rail-panel"]'),
          ),
        ).toBe(true);
        await expectNoNavigationLoading(page);
      } finally {
        gate.release();
      }
      if (viewport.width < 768) await page.getByTestId('mobile-sessions-open').click();
      await page.getByTestId('session-open-s1').click();
      await expect(page.getByTestId('composer-input')).toHaveValue('draft for session one');
      expect(await rail!.evaluate((element) => element.isConnected)).toBe(true);
      await expectNoNavigationLoading(page);
    });
  });
}

test.describe('workspace template navigation', () => {
  test.use({ sessionCount: 2, workspaceCount: 2 });

  test('keeps the launch template across workspace selection and Settings remounts', async ({ context, cockpit }) => {
    const destination = cockpit.workspaces[1]!;
    fs.mkdirSync(path.join(destination.root, '.doom'), { recursive: true });
    fs.writeFileSync(path.join(destination.root, '.doom', 'config.yaml'), `web:\n  template: ${ELEGANT}\n`);
    const page = await context.newPage();
    await recordTemplateStartup(page);
    await page.goto(`${cockpit.url}/session/s1`);
    await expectFirstTemplate(page, ADVANCED);
    const rail = await page.getByTestId('session-rail-panel').elementHandle();
    await recordNavigationLoading(page);
    await page.getByTestId('session-open-s2').click();
    await expect(page.getByTestId('session-card-s2')).toHaveAttribute('data-active', 'true');
    expect(await rail!.evaluate((element) => element.isConnected)).toBe(true);
    await expectNoNavigationLoading(page);
    await expectFirstTemplate(page, ADVANCED);
    await openAppearance(page);
    await page.getByTestId('template-scope').click();
    await page.getByRole('option', { name: `Workspace: ${destination.root}`, exact: true }).click();
    await expect(page.getByTestId('template-origin')).toContainText(`${ELEGANT} (repository)`);
    await expectFirstTemplate(page, ADVANCED);
    await page.getByTestId('template-scope').click();
    await page.getByRole('option', { name: 'Global default', exact: true }).click();
    await expect(page.getByTestId('template-origin')).toContainText('automatic fallback');
    await expectFirstTemplate(page, ADVANCED);
    await page.getByTestId('settings-close').click();
    await expect(page.getByTestId('session-card-s2')).toHaveAttribute('data-active', 'true');
    await expectFirstTemplate(page, ADVANCED);
    await expectNoNavigationLoading(page);
  });
});

test.describe('session rail scroll', () => {
  test.use({ sessionCount: 8, viewport: { width: 1280, height: 480 } });

  test('keeps the rail position when selecting another session', async ({ page, cockpit }) => {
    await page.goto(`${cockpit.url}/session/s1`);
    await cockpit.session.waitForAttach();
    const rail = page.getByTestId('session-rail-panel');
    const target = page.getByTestId('session-open-s8');
    await target.scrollIntoViewIfNeeded();
    const scrollTop = await rail.evaluate((element) => element.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);

    await target.click();
    await expect(page.getByTestId('session-card-s8')).toHaveAttribute('data-active', 'true');
    expect(await rail.evaluate((element) => element.scrollTop)).toBeCloseTo(scrollTop, 0);
  });
});

test('changes packages without losing a draft or attachment, and persists the default', async ({
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
  await page.screenshot({ path: testInfo.outputPath('advanced.png') });
  await openAppearance(page);
  await saveChoice(page, ELEGANT);
  await page.getByTestId('settings-close').click();
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ELEGANT);
  await expect(page.getByTestId('composer-input')).toHaveValue('Keep this draft across templates');
  await expect(page.getByTestId('composer-attachments')).toContainText('retained.txt');
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

test('uses the backend mount for a same-id template regardless of the Settings target', async ({ page, cockpit }) => {
  await page.goto(`${cockpit.url}/settings/appearance`);
  await saveChoice(page, 'independent-reader');
  await expect(page.getByTestId('independent-template')).toHaveAttribute('data-template-scope', 'workspace');
  await page.getByTestId('independent-workspace-settings').click();
  await expect(page.getByTestId('independent-template')).toHaveAttribute('data-template-scope', 'workspace');
  await page.getByTestId('settings-workspace-general').click();
  await page.getByTestId('settings-section-appearance').click();
  await workspaceScope(page);
  await page.getByTestId('template-scope').click();
  await page.getByRole('option', { name: 'Global default', exact: true }).click();
  await expect(page.getByTestId('independent-template')).toHaveAttribute('data-template-scope', 'workspace');
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', 'independent-reader');
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
  test(`first renders ${template} from compositions while scoped Settings configuration is pending`, async ({
    context,
    cockpit,
  }) => {
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
      await expectFirstTemplate(page, template);
      await expect(page.getByTestId('composer-input')).toBeVisible();
      await openAppearance(page);
      await expect(page.getByTestId('template-save')).toBeDisabled();
      await expectFirstTemplate(page, template);
      releaseConfiguration();
      await expect(page.getByTestId('template-save')).toBeEnabled();
      await expectFirstTemplate(page, template);
      await page.getByTestId('settings-close').click();
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
  test(`renders the launch template on ${entry} before the WS session snapshot arrives`, async ({
    context,
    cockpit,
  }) => {
    const page = await context.newPage();
    const configFile = path.join(cockpit.workspaces[0]!.root, '.doom', 'config.yaml');
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
      await expectFirstTemplate(page, ELEGANT);
      await expect(page.getByTestId('template-loading')).toHaveCount(0);
      await expect(page.getByTestId('template-diagnostic')).toHaveCount(0);
      await expect(page.getByTestId('session-card-s1')).toHaveCount(0);
      await expect(page.getByTestId('welcome')).toHaveCount(0);
      for (const release of releaseSockets) release();
      await expect(page).toHaveURL(/\/session\/s1$/);
      await expectFirstTemplate(page, ELEGANT);
      await expect(page.getByTestId('composer-input')).toBeEnabled();
    } finally {
      for (const release of releaseSockets) release();
    }
  });
}

test('retains the chosen template on reconnect and adopts changed launch config only on Settings Reload', async ({
  context,
  cockpit,
}) => {
  const page = await context.newPage();
  const closeSockets: Array<() => Promise<void>> = [];
  await page.routeWebSocket(/.*/, (socket) => {
    socket.connectToServer();
    closeSockets.push(() => socket.close());
  });
  await recordTemplateStartup(page);
  await page.goto(`${cockpit.url}/session/s1`);
  await expectFirstTemplate(page, ADVANCED);
  await expect(page.getByTestId('session-card-s1')).toBeVisible();
  const file = path.join(cockpit.workspaces[0]!.root, '.doom', 'config.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `web:\n  template: ${ELEGANT}\n`);
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/compositions');
  await Promise.all(closeSockets.splice(0).map((close) => close()));
  expect((await (await refreshed).json()).template).toEqual({
    id: ELEGANT,
    mount: { scope: 'workspace', workspaceId: cockpit.workspaces[0]!.id },
  });
  await expectFirstTemplate(page, ADVANCED);
  await openAppearance(page);
  await workspaceScope(page);
  await expect(page.getByTestId('template-origin')).toContainText(`${ELEGANT} (repository)`);
  await expectFirstTemplate(page, ADVANCED);
  await page.getByTestId('template-reload').click();
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ELEGANT);
  await page.getByTestId('settings-close').click();
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ELEGANT);
});

test('reports composition bootstrap failure and retries without a stuck loading screen', async ({
  context,
  cockpit,
}) => {
  const page = await context.newPage();
  let failing = true;
  await page.route('**/api/compositions', async (route) => {
    if (failing) await route.fulfill({ status: 503, json: { error: 'Bootstrap temporarily unavailable' } });
    else await route.continue();
  });
  await page.goto(`${cockpit.url}/settings/appearance`);
  await expect(page.getByTestId('template-diagnostic')).toContainText('503');
  await expect(page.getByTestId('template-loading')).toHaveCount(0);
  await expect(page.getByTestId('template-diagnostic')).not.toContainText('No compatible');
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ADVANCED);
  failing = false;
  await page.getByRole('button', { name: 'Retry templates' }).click();
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ADVANCED);
  await expect(page.getByTestId('template-diagnostic')).toHaveCount(0);
});

test('keeps the template usable when Settings configuration fails and reloads the editor explicitly', async ({
  context,
  cockpit,
}) => {
  const page = await context.newPage();
  let failing = true;
  await page.route(
    (url) => url.pathname === '/api/settings' && url.searchParams.has('key'),
    async (route) => {
      if (failing) await route.fulfill({ status: 503, json: { error: 'Configuration temporarily unavailable' } });
      else await route.continue();
    },
  );
  await page.goto(`${cockpit.url}/settings/appearance`);
  await expect(page.getByTestId('template-save-error')).toContainText('Configuration temporarily unavailable');
  await expect(page.getByTestId('template-loading')).toHaveCount(0);
  await expect(page.getByTestId('template-diagnostic')).toHaveCount(0);
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ADVANCED);
  failing = false;
  await page.getByTestId('template-reload').click();
  await expect(page.getByTestId('template-save-error')).toHaveCount(0);
  await expect(page.getByTestId('template-save')).toBeEnabled();
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ADVANCED);
});

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

test('opens host dialogs from shortcuts while the Elegant session drawer is closed', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ADVANCED);
  await openAppearance(page);
  await saveChoice(page, ELEGANT);
  await page.goto(cockpit.url);
  await expect(page.locator('[data-template]')).toHaveAttribute('data-template', ELEGANT);
  await expect(page.getByTestId('session-rail-panel')).toBeHidden();

  await page.keyboard.press('Control+t');
  await expect(page.getByTestId('new-session-dialog')).toBeVisible();
});
