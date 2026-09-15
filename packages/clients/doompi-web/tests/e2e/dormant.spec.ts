import { expect, test } from '../support/cockpit';

test.use({ sessionCount: 1, dormantSessionCount: 1 });

test('shows a recorded session as stopped and starts it only when asked', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);

  // A restart leaves the record but no runtime. The rail still lists it, so the
  // work is findable rather than lost with the process that held it.
  const card = page.getByTestId('session-card-d1');
  await expect(card).toContainText('dormant-1');
  await expect(card).toContainText('stopped');

  // The recorded session is the oldest, so the cockpit's auto-focus lands on
  // it. Focus must not be enough to start an agent: that is the whole point of
  // restoring lazily, and the card staying stopped is the proof.
  await expect(page.getByTestId('dormant-session')).toBeVisible();
  await expect(page.getByTestId('composer-input')).toBeHidden();
  await expect(card).toContainText('stopped');

  // A live session is still reachable without touching the dormant one.
  await page.getByTestId('session-open-s1').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByTestId('dormant-session')).toBeHidden();
  await expect(card).toContainText('stopped');

  await page.getByTestId('session-open-d1').click();
  await expect(page.getByTestId('dormant-session')).toBeVisible();
  await page.getByTestId('dormant-wake').click();

  // The revived session arrives as an ordinary upsert under the same id, so the
  // panel gives way to the conversation and the card stops saying stopped.
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByTestId('dormant-session')).toBeHidden();
  await expect(card).not.toContainText('stopped');
});
