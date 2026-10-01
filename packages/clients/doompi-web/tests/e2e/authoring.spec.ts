import fs from 'node:fs';
import path from 'node:path';

import { type CockpitFixture, expect, test } from '../support/cockpit';

test.use({ assets: 'synced' });

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';

function openReviewCanvas(cockpit: CockpitFixture): void {
  fs.writeFileSync(path.join(cockpit.session.cwd, 'review.png'), Buffer.from(PNG, 'base64'));
  cockpit.session.emit({
    type: 'entry_appended',
    entry: {
      type: 'custom',
      customType: 'doom-minor-modes',
      data: {
        version: 1,
        revision: 1,
        modes: [
          {
            id: 'author',
            label: 'Author',
            description: '',
            order: 20,
            activation: 'active',
            condition: 'ready',
            actions: [],
          },
        ],
      },
    },
  });
  cockpit.session.emit({
    type: 'tool_execution_start',
    toolCallId: 'author-open',
    toolName: 'open_authoring_file',
    args: { path: 'review.png', alias: 'review' },
  });
  cockpit.session.emit({
    type: 'tool_execution_end',
    toolCallId: 'author-open',
    result: {
      content: [{ type: 'text', text: 'Opened review.png' }],
      details: { path: 'review.png', byteLength: 70, alias: 'review', status: 'opening', reused: false },
    },
    isError: false,
  });
}

test('opens and reopens a named Author canvas with phone-sized feedback controls', async ({ page, cockpit }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  openReviewCanvas(cockpit);

  // The completion opens its temporary tab automatically; the browser still uses the real Author document API.
  const canvas = page.getByTestId('author-document');
  await expect(canvas).toBeVisible();
  await expect(canvas.getByRole('button', { name: 'Zoom in' })).toBeVisible();
  const draw = canvas.getByRole('button', { name: 'Draw' });
  await expect(draw).toBeVisible();
  await draw.click();
  await expect(draw).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('tab-conversation').click();
  await expect(canvas).toHaveCount(0);
  await page.getByTestId('top-bar').getByText('review · review.png').click();
  await expect(canvas).toBeVisible();
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(horizontalOverflow).toBe(false);
});

test('names the open Author document only in messages typed under its tab', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  openReviewCanvas(cockpit);
  await expect(page.getByTestId('author-document')).toBeVisible();

  await page.getByTestId('composer-input').fill('Make the logo larger');
  await page.getByTestId('composer-send').click();
  const prompt = await cockpit.session.waitForCommand('prompt');
  expect(prompt.message).toBe(
    'Make the logo larger\n\nReferenced context "review · review.png":\n\nAuthor document: review.png (canvas review)',
  );

  await page.getByTestId('tab-conversation').click();
  await page.getByTestId('composer-input').fill('Thanks');
  await page.getByTestId('composer-send').click();
  // The second send may be a prompt or a steer, depending on whether the fake run is still active.
  await expect.poll(() => cockpit.session.received.some((frame) => frame.message === 'Thanks')).toBe(true);
});
