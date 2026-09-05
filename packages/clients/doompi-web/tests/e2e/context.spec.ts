import { expect, test } from '../support/cockpit.ts';

// The context face reads the same footer status line the composer chips read,
// so these drive it the way DoomPi really publishes it rather than seeding a
// store directly.
const status = (statusKey: string, statusText?: string) => ({
  type: 'extension_ui_request',
  id: `st-${statusKey}-${Math.random()}`,
  method: 'setStatus',
  statusKey,
  ...(statusText === undefined ? {} : { statusText }),
});

const SELECTION = '[copilot]:development,testing';

test('opens on activity and offers context beside it', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);

  await expect(page.getByTestId('activity-dock')).toBeVisible();
  await expect(page.getByTestId('dock-tab-activity')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('dock-tab-context')).toHaveAttribute('data-active', 'false');
  await expect(page.getByTestId('activity-scroll')).toBeVisible();
  await expect(page.getByTestId('context-panel')).toBeHidden();
});

test('swaps the dock body for the composition without losing the dock', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);

  await page.getByTestId('dock-tab-context').click();

  await expect(page.getByTestId('context-panel')).toBeVisible();
  await expect(page.getByTestId('activity-scroll')).toBeHidden();
  // The frame survives the swap: the dock and its hide control are host-owned.
  await expect(page.getByTestId('activity-dock')).toBeVisible();
  await expect(page.getByTestId('activity-close')).toBeVisible();
});

test('groups the active major mode and its domains under # heads', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-major-mode', SELECTION));
  await page.getByTestId('dock-tab-context').click();

  await expect(page.getByTestId('context-group-copilot')).toBeVisible();
  await expect(page.getByTestId('context-group-development')).toBeVisible();
  await expect(page.getByTestId('context-group-testing')).toBeVisible();
  await expect(page.getByTestId('context-group-copilot')).toHaveAttribute('data-kind', 'major');
  await expect(page.getByTestId('context-group-development')).toHaveAttribute('data-kind', 'domain');
  await expect(page.getByTestId('context-empty')).toBeHidden();
});

test('says so plainly when the session has published no composition', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);

  await page.getByTestId('dock-tab-context').click();

  await expect(page.getByTestId('context-empty')).toBeVisible();
});

test.describe('with the synced MCP context contribution', () => {
  test.use({ assets: 'synced' });

  test('shows zero-tool auth needs, sends one exact keyboard request, and follows live status changes', async ({
    page,
    cockpit,
  }) => {
    const serverName = 'pencil/v2 --profile=review';
    await page.goto(cockpit.url);
    await cockpit.session.waitForAttach();

    cockpit.session.emit(status('doom-mcp-session-auth', JSON.stringify([{ name: serverName, state: 'needs-auth' }])));
    await page.getByTestId('dock-tab-context').click();

    await expect(page.getByTestId('context-empty')).toBeVisible();
    const auth = page.getByTestId('context-mcp-auth');
    await expect(auth).toBeVisible();
    const serverList = auth.getByRole('list', { name: 'MCP servers', exact: true });
    const serverRow = serverList.getByRole('listitem').filter({ hasText: serverName });
    await expect(serverRow).toHaveCount(1);

    const authorize = serverRow.getByRole('button', { name: 'authorize' });
    await authorize.focus();
    await expect(authorize).toBeFocused();
    const commandOffset = cockpit.session.received.length;
    await page.keyboard.press('Enter');

    await expect
      .poll(() => cockpit.session.received.slice(commandOffset).filter((frame) => frame.type === 'prompt'))
      .toEqual([{ type: 'prompt', message: `/mcp auth ${serverName}` }]);

    cockpit.session.emit(status('doom-mcp-session-auth', ''));
    await expect(auth).toBeHidden();
    await page.getByTestId('mcp-authorization-dialog').getByRole('button', { name: 'close', exact: true }).click();
    cockpit.session.emit(status('doom-mcp-session-auth', JSON.stringify([{ name: 'linear', state: 'needs-auth' }])));
    await expect(auth).toBeVisible();
    await expect(serverList.getByRole('listitem')).toHaveCount(1);
    await expect(serverList).toContainText('linear');
    await expect(serverList).not.toContainText(serverName);
  });
  test('opens OAuth in a new tab and keeps a copyable manual link in the dialog', async ({ page, cockpit }) => {
    await page.context().route('https://auth.example.test/**', (route) => route.fulfill({ body: 'Provider sign-in' }));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (value: string) => {
            localStorage.setItem('copied-oauth-link', value);
          },
        },
      });
    });
    await page.goto(cockpit.url);
    await cockpit.session.waitForAttach();
    cockpit.session.emit(status('doom-mcp-session-auth', JSON.stringify([{ name: 'agiflow-mcp', state: 'failed' }])));
    await page.getByTestId('dock-tab-context').click();
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Authorize agiflow-mcp', exact: true }).click();
    const popup = await popupPromise;
    const dialog = page.getByTestId('mcp-authorization-dialog');
    await expect(dialog).toBeVisible();
    await expect
      .poll(() => cockpit.session.received.filter((frame) => frame.type === 'prompt'))
      .toEqual([{ type: 'prompt', message: '/mcp auth agiflow-mcp' }]);
    const authorizationUrl = 'https://auth.example.test/oauth?state=example&code_challenge=test';
    cockpit.session.emit(
      status('doom-mcp-session-auth', JSON.stringify([{ name: 'agiflow-mcp', state: 'needs-auth', authorizationUrl }])),
    );
    await expect(popup).toHaveURL(authorizationUrl);
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    await expect(dialog.getByRole('textbox', { name: 'OAuth authorization URL' })).toHaveValue(authorizationUrl);
    await expect(dialog.getByRole('link', { name: 'open authorization page' })).toHaveAttribute(
      'href',
      authorizationUrl,
    );
    await dialog.getByRole('button', { name: 'copy link' }).click();
    await expect(dialog).toContainText('Link copied.');
    expect(await page.evaluate(() => localStorage.getItem('copied-oauth-link'))).toBe(authorizationUrl);
    cockpit.session.emit(
      status('doom-mcp-session-auth', JSON.stringify([{ name: 'agiflow-mcp', state: 'connected' }])),
    );
    await expect(dialog).toContainText('Authorization complete.');
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'close', exact: true }).click();
    expect(popup.isClosed()).toBe(false);
    const serverList = page.getByRole('list', { name: 'MCP servers', exact: true });
    await expect(serverList).toContainText('agiflow-mcp');
    await expect(serverList).toContainText('connected');
    const pageCount = page.context().pages().length;
    await serverList.getByRole('button', { name: 'Manage agiflow-mcp', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'reauthorize', exact: true })).toBeVisible();
    expect(page.context().pages()).toHaveLength(pageCount);
    expect(cockpit.session.received.filter((frame) => frame.type === 'prompt')).toHaveLength(1);
    await dialog.getByRole('button', { name: 'disconnect', exact: true }).click();
    await expect
      .poll(() => cockpit.session.received.filter((frame) => frame.type === 'prompt'))
      .toEqual([
        { type: 'prompt', message: '/mcp auth agiflow-mcp' },
        { type: 'prompt', message: '/mcp disconnect agiflow-mcp' },
      ]);
    expect(page.context().pages()).toHaveLength(pageCount);
    cockpit.session.emit(status('doom-mcp-session-auth', JSON.stringify([{ name: 'agiflow-mcp', state: 'closed' }])));
    await expect(dialog).toContainText('Disconnected from this session. Saved credentials were kept.');
    await expect(dialog.getByRole('button', { name: 'disconnect', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('context-mcp-auth')).toContainText('closed');
    const retryPopupPromise = page.waitForEvent('popup');
    await dialog.getByRole('button', { name: 'reauthorize', exact: true }).click();
    const retryPopup = await retryPopupPromise;
    await expect.poll(() => cockpit.session.received.filter((frame) => frame.type === 'prompt')).toHaveLength(3);
    expect(cockpit.session.received.filter((frame) => frame.type === 'prompt').at(-1)).toEqual({
      type: 'prompt',
      message: '/mcp auth agiflow-mcp',
    });
    await dialog.getByRole('button', { name: 'close', exact: true }).click();
    await expect.poll(() => retryPopup.isClosed()).toBe(true);
    await popup.close();
  });

  test('keeps manual authorization usable when popups and clipboard are blocked', async ({ page, cockpit }) => {
    await page.addInitScript(() => {
      window.open = () => null;
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async () => {
            throw new Error('permission denied');
          },
        },
      });
    });
    await page.goto(cockpit.url);
    await cockpit.session.waitForAttach();
    const authorizationUrl = 'https://auth.example.test/oauth?state=manual';
    cockpit.session.emit(
      status('doom-mcp-session-auth', JSON.stringify([{ name: 'agiflow-mcp', state: 'connecting', authorizationUrl }])),
    );
    await page.getByTestId('dock-tab-context').click();
    await page.getByRole('button', { name: 'Authorize agiflow-mcp', exact: true }).click();
    const dialog = page.getByTestId('mcp-authorization-dialog');
    await expect(dialog).toContainText('browser blocked the new tab');
    await expect(dialog.getByRole('link')).toHaveAttribute('href', authorizationUrl);
    await dialog.getByRole('button', { name: 'copy link' }).click();
    await expect(dialog).toContainText('copy it manually');
    await expect(dialog.getByRole('textbox')).toHaveValue(authorizationUrl);
    expect(cockpit.session.received.filter((frame) => frame.type === 'prompt')).toEqual([]);
  });
});
test('reports the estimate as an estimate', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-major-mode', SELECTION));
  await page.getByTestId('dock-tab-context').click();

  // Nothing is priced until the runtime publishes an inventory, and an em dash
  // is the honest reading of that rather than a confident zero.
  await expect(page.getByTestId('context-total')).toHaveText('—');
  await expect(page.getByTestId('context-panel')).toContainText('not a billed total');
});

// A row is a question as much as a figure, so it has to be answerable. The
// fake session behind these tests serves no package API, which is exactly the
// case a reader must not be left staring at a spinner for.
test('opens a row and says so when the session cannot describe it', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'entry_appended',
    entry: {
      type: 'custom',
      id: 'ctx-1',
      customType: 'doom-context',
      data: {
        version: 1,
        revision: 1,
        estimator: 'gpt-tokenizer',
        totalTokens: 153,
        inactiveTokens: 0,
        groups: [
          {
            id: 'core',
            label: 'core',
            kind: 'core',
            tokens: 153,
            inactiveTokens: 0,
            items: [
              {
                name: 'read',
                itemKind: 'tool',
                source: 'extension',
                owner: '@agimon-ai/doompi-read',
                tokens: 153,
                active: true,
              },
            ],
          },
        ],
      },
    },
  });
  await page.getByTestId('dock-tab-context').click();

  await page.getByTestId('context-row-read').click();

  await expect(page.getByTestId('context-item-dialog')).toBeVisible();
  await expect(page.getByTestId('context-item-title')).toHaveText('read');
  await expect(page.getByTestId('context-item-error')).toBeVisible();
});
