import { expect, test } from '../support/cockpit';

const REPLY = [
  'Here is the shape of it.',
  '',
  '```ts',
  'const gate = 1;',
  '```',
  '',
  '```mermaid',
  'graph TD;',
  '  A-->B;',
  '```',
].join('\n');

test('renders a fenced block coloured and a mermaid fence as a diagram', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: REPLY } });
  cockpit.session.emit({ type: 'agent_settled' });

  const code = page.locator('[data-slot="code-block"][data-language="ts"]');
  await expect(code).toContainText('const gate = 1;');
  // The grammar chunk lands after the first paint, and only then is the block coloured.
  await expect(code.locator('[data-slot="syntax-text"]')).toHaveAttribute('data-highlighted', 'true');

  const diagram = page.locator('[data-slot="code-block"][data-language="mermaid"]').getByTestId('mermaid-diagram');
  await expect(diagram.locator('svg')).toBeVisible();
});

test('copies a code block to the clipboard', async ({ page, context, cockpit }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: ['```ts', 'const gate = 1;', '```'].join('\n') },
  });
  cockpit.session.emit({ type: 'agent_settled' });

  await page.locator('[data-slot="code-block"]').getByTestId('copy-button').click();
  await expect(page.getByTestId('copy-button')).toHaveAttribute('data-state', 'copied');
  await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe('const gate = 1;');
});
