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

test.describe('mobile composer actions', () => {
  test.use({ assets: 'synced' });

  test('places voice before queue and reflects manual and autonomous phases', async ({ page, cockpit }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(cockpit.url);
    await cockpit.session.waitForAttach();

    const voice = page.getByTestId('composer-voice-action');
    const queue = page.getByTestId('composer-queue');
    const promptMessages = () =>
      cockpit.session.received.filter((frame) => frame.type === 'prompt').map((frame) => frame.message);
    const clickAndExpectPrompt = async (message: string) => {
      const count = promptMessages().length;
      await voice.click();
      await expect.poll(() => promptMessages().length).toBe(count + 1);
      expect(promptMessages().at(-1)).toBe(message);
    };
    await expect(voice).toBeVisible();
    await expect(voice).toHaveAttribute('aria-label', 'start voice recording');
    const voiceBox = await voice.boundingBox();
    const queueBox = await queue.boundingBox();
    expect(voiceBox).not.toBeNull();
    expect(queueBox).not.toBeNull();
    expect((voiceBox?.x ?? 0) + (voiceBox?.width ?? 0)).toBeLessThanOrEqual(queueBox?.x ?? 0);

    await clickAndExpectPrompt('/voice');

    cockpit.session.emit({
      type: 'extension_ui_request',
      id: 'voice-recording',
      method: 'setStatus',
      statusKey: 'doom-voice',
      statusText: 'voice: recording 0:03',
    });
    await expect(voice).toHaveAttribute('data-voice-phase', 'recording');
    await expect(voice).toHaveAttribute('aria-label', 'stop voice recording and fill the prompt');
    await clickAndExpectPrompt('/voice');

    const phases = [
      ['listening', 'voice auto: listening'],
      ['hearing', 'voice auto: hearing speech'],
      ['processing', 'voice auto: processing while listening'],
      ['composing', 'voice auto: composing, listening'],
      ['sending', 'voice auto: sending composed prompt'],
      ['narrating', 'voice auto: narrating and listening'],
      ['confirming', 'voice auto: confirmation needed'],
    ] as const;
    const icons = new Set<string>();
    for (const [phase, statusText] of phases) {
      cockpit.session.emit({
        type: 'extension_ui_request',
        id: `voice-${phase}`,
        method: 'setStatus',
        statusKey: 'doom-voice',
        statusText,
      });
      await expect(voice).toHaveAttribute('data-voice-phase', phase);
      icons.add((await voice.locator('svg').getAttribute('class')) ?? '');
    }
    expect(icons.size).toBe(phases.length);
    await clickAndExpectPrompt('/minor voice-auto deactivate');

    await page.setViewportSize({ width: 900, height: 844 });
    await expect(voice).toBeHidden();
  });
});
