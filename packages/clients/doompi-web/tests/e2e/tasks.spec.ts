import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '../support/cockpit.ts';

test.use({ assets: 'synced' });

function writeTasks(agentDir: string): void {
  const storePath = path.join(agentDir, 'doom-task', 's1', 'tasks.json');
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      rev: 1,
      nextId: 6,
      tasks: [
        { id: 1, subject: 'Pending task', description: 'waiting to start', status: 'pending', blockedBy: [] },
        {
          id: 2,
          subject: 'Running task',
          description: 'original detail',
          activeForm: 'working now',
          status: 'in_progress',
          blockedBy: [],
        },
        { id: 3, subject: 'Completed task', status: 'completed', blockedBy: [] },
        { id: 4, subject: 'Failed task', status: 'failed', blockedBy: [] },
        { id: 5, subject: 'Deleted task', status: 'deleted', blockedBy: [] },
      ],
    }),
  );
}

async function expectLatestPrompt(cockpit: { session: { received: Array<Record<string, unknown>> } }, message: string) {
  await expect
    .poll(() => cockpit.session.received.filter((frame) => frame.type === 'prompt').at(-1)?.message)
    .toBe(message);
}

test('task actions use an accessible menu without changing their commands', async ({ page, cockpit }) => {
  writeTasks(cockpit.agentDir);
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  const pendingMenu = page.getByTestId('activity-task-menu-1');
  const runningMenu = page.getByTestId('activity-task-menu-2');
  await expect(pendingMenu).toHaveAccessibleName('task #1 actions');
  await expect(runningMenu).toBeVisible();
  const [titleBox, menuBox] = await Promise.all([
    page.getByTestId('activity-task-title-1').boundingBox(),
    pendingMenu.boundingBox(),
  ]);
  if (titleBox === null || menuBox === null) throw new Error('Task title and menu must be measurable.');
  expect(Math.abs(titleBox.y + titleBox.height / 2 - (menuBox.y + menuBox.height / 2))).toBeLessThanOrEqual(2);
  await expect(page.getByRole('button', { name: /^(edit|note|remove)$/i })).toHaveCount(0);

  await pendingMenu.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByTestId('activity-task-menu-list-1');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem').allTextContents()).resolves.toEqual(['Edit', 'Note', 'Remove']);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(pendingMenu).toBeFocused();

  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  const edit = page.getByPlaceholder('what should change');
  await expect(edit).toBeFocused();
  await edit.fill('use the public API');
  await page.getByTestId('activity-task-1').getByRole('button', { name: 'send' }).click();
  await expectLatestPrompt(
    cockpit,
    'Update task #1 according to this instruction. Preserve a valid dependency graph: use the public API',
  );
  await expect(edit).toHaveCount(0);

  await pendingMenu.click();
  await page.getByTestId('activity-task-note-1').click();
  const note = page.getByPlaceholder('note for the agent');
  await expect(note).toBeFocused();
  await note.fill('check the edge case');
  await page.getByTestId('activity-task-1').getByRole('button', { name: 'send' }).click();
  await expectLatestPrompt(
    cockpit,
    'Send this note to the agent working on task #1, then update the task if needed: check the edge case',
  );

  await runningMenu.click();
  await page.getByTestId('activity-task-remove-2').click();
  await expectLatestPrompt(
    cockpit,
    'Remove task #2. Also remove or repair every dependency that references it so the remaining task graph is valid.',
  );

  await page.getByTestId('activity-tasks').getByRole('button', { name: 'session' }).click();
  await expect(page.getByTestId('activity-task-3')).toBeVisible();
  await expect(page.getByTestId('activity-task-menu-3')).toHaveCount(0);
  await expect(page.getByTestId('activity-task-menu-4')).toBeVisible();
  await expect(page.getByTestId('activity-task-5')).toHaveCount(0);
});
