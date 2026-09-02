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
