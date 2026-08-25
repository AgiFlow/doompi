import { expect, test } from '../support/cockpit.ts';

/** One journalled user message, as Pi's get_entries reports it. */
const message = (index: number) => ({
  type: 'message',
  id: `j${index}`,
  message: { role: 'user', content: [{ type: 'text', text: `line ${index}` }] },
});

test('pages back through a transcript longer than the attach restores', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_entries');

  // Longer than the hub's restore limit, so the page opens on the tail and the
  // rest exists only in what the hub retained for paging.
  const entries = Array.from({ length: 420 }, (_, index) => message(index));
  cockpit.session.emit({
    type: 'response',
    command: 'get_entries',
    success: true,
    data: { entries, leafId: 'j419' },
  });

  const timeline = page.getByTestId('timeline');
  await expect(page.getByText('line 419')).toBeVisible();
  // The oldest restored line, not the oldest line: the attach kept the tail.
  await expect(page.getByText('line 120')).toBeVisible();
  await expect(page.getByText('line 60')).toHaveCount(0);

  await timeline.evaluate((element) => {
    element.scrollTop = 0;
  });

  // Scrolling to the top asks the hub for the window above, which arrives and
  // is prepended without the reader losing their place.
  await expect(page.getByText('line 60')).toBeVisible();
  await expect(page.getByText('line 419')).toBeVisible();
});

test('stops asking once the transcript has no more above it', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_entries');

  const entries = Array.from({ length: 320 }, (_, index) => message(index));
  cockpit.session.emit({
    type: 'response',
    command: 'get_entries',
    success: true,
    data: { entries, leafId: 'j319' },
  });

  const timeline = page.getByTestId('timeline');
  await expect(page.getByText('line 319')).toBeVisible();

  // Two trips are enough to reach the start of a 320-line transcript.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await timeline.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.waitForTimeout(300);
  }

  await expect(page.getByText('line 0')).toBeVisible();
});
