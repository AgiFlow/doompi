import { expect, test } from '../support/cockpit';

/** One journalled user message in the session transcript. */
const message = (index: number) => ({
  type: 'message',
  id: `j${index}`,
  message: { role: 'user', content: [{ type: 'text', text: `line ${index}` }] },
});

test('pages back through a transcript longer than the attach restores', async ({ page, cockpit }) => {
  // Longer than the hub's restore limit, so the page opens on the tail and the
  // rest exists only in what the hub retained for paging.
  const entries = Array.from({ length: 420 }, (_, index) => message(index));
  cockpit.session.replaceEntries(entries);

  await page.goto(cockpit.url);

  const timeline = page.getByTestId('timeline');
  await expect(page.getByText('line 419')).toBeVisible();
  // The virtualized timeline initially renders only the visible end of the restored tail.
  await expect(page.getByText('line 60')).toHaveCount(0);

  // Scrolling to the top asks the hub for the window above, which arrives and
  // is prepended without the reader losing their place. Retry the gesture while
  // a preceding request is in flight rather than relying on a fixed sleep.
  await expect(async () => {
    await timeline.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect(page.getByText('line 60')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByText('line 419')).toBeVisible();
});

test('stops asking once the transcript has no more above it', async ({ page, cockpit }) => {
  const entries = Array.from({ length: 320 }, (_, index) => message(index));
  cockpit.session.replaceEntries(entries);

  await page.goto(cockpit.url);

  const timeline = page.getByTestId('timeline');
  await expect(page.getByText('line 319')).toBeVisible();

  await expect(async () => {
    await timeline.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect(page.getByText('line 0')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
});
