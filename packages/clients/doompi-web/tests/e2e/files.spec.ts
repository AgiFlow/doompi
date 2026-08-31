import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '../support/cockpit.ts';

test.use({ assets: 'synced' });

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function writeChangedFiles(registryDir: string, agentDir: string): void {
  const record = JSON.parse(fs.readFileSync(path.join(registryDir, 'sessions', 's1.json'), 'utf8')) as { cwd: string };
  const relPaths = [
    'src/Newest.ts',
    'src/Second.ts',
    'docs/Third.md',
    'src/Fourth.ts',
    'src/Fifth.ts',
    'src/HiddenTarget.ts',
  ];
  const events: Array<Record<string, unknown>> = [];

  relPaths.forEach((relPath, index) => {
    const filePath = path.join(record.cwd, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `content for ${relPath}\n`);
    events.push({
      version: 2,
      path: filePath,
      tool: index === 5 ? 'bash' : 'edit',
      at: 100 - index,
      origin: index === 5 ? 'scan' : 'tool',
      ...(index === 5 ? {} : { before: 'before', after: 'after' }),
    });
  });

  const hiddenPath = path.join(record.cwd, 'src/HiddenTarget.ts');
  events.push({ version: 2, path: hiddenPath, tool: 'write', at: 1, origin: 'scan' });

  const timelineDir = path.join(agentDir, 'doom-file-edit');
  fs.mkdirSync(timelineDir, { recursive: true });
  const timelinePath = path.join(timelineDir, `${hash(fs.realpathSync(record.cwd))}-${hash('s1')}.jsonl`);
  fs.writeFileSync(timelinePath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
}

test('files browser searches and opens the complete changed-file list', async ({ page, cockpit }) => {
  writeChangedFiles(cockpit.registryDir, cockpit.agentDir);
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'files-status',
    method: 'setStatus',
    statusKey: 'doom-file-edit-files',
    statusText: '6 files',
  });
  const compact = page.getByTestId('activity-file-edits');
  await expect(compact.locator('[data-file-diffable]')).toHaveCount(5);
  await expect(compact).toContainText('src/Fifth.ts');
  await expect(compact).not.toContainText('HiddenTarget');
  await expect(page.getByTestId('activity-files')).toHaveAttribute('data-active', 'false');
  await expect(page.getByTestId('background-work-notice')).toBeHidden();

  const showAll = page.getByTestId('activity-files-show-all');
  await expect(showAll).toHaveText('show all 6 files');
  await showAll.click();

  const browser = page.getByTestId('files-browser');
  const search = page.getByTestId('files-browser-search');
  await expect(browser).toBeVisible();
  await expect(search).toBeFocused();
  await expect(page.getByTestId('files-browser-total')).toHaveText('6 changed');
  await expect(page.getByTestId('files-browser-matches')).toContainText('6 matches');

  await search.fill('hIdDeNtArGeT');
  await expect(page.getByTestId('files-browser-matches')).toContainText('1 matches');
  const hidden = page.getByTestId('files-browser-file-src/HiddenTarget.ts');
  await expect(hidden).toContainText('2×');
  await expect(hidden).toContainText('command');
  await expect(hidden).toHaveAttribute('data-file-diffable', 'false');
  await expect(hidden).toHaveAttribute('title', /no diff was captured/u);

  const clear = page.getByTestId('files-browser-clear');
  await page.mouse.move(0, 0);
  await clear.focus();
  await expect(clear).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('files-browser-matches')).toContainText('6 matches');
  await expect(browser).toBeVisible();
  await expect(page.getByTestId('files-file-panel')).toHaveCount(0);

  const options = browser.getByRole('option');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(browser).toHaveCount(0);
  await expect(page.getByTestId('files-file-panel')).toBeVisible();
  await expect(page.getByTestId('files-breadcrumb')).toContainText('src/Second.ts');

  await showAll.click();
  await expect(browser).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(browser).toHaveCount(0);

  await showAll.click();
  const close = page.getByTestId('files-browser-close');
  await close.focus();
  await expect(close).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(browser).toHaveCount(0);
  await expect(page.getByTestId('files-breadcrumb')).toContainText('src/Second.ts');

  await showAll.click();
  await page.getByTestId('files-browser-search').fill('HiddenTarget');
  await page.getByTestId('files-browser-file-src/HiddenTarget.ts').click();
  await expect(browser).toHaveCount(0);
  await expect(page.getByTestId('files-breadcrumb')).toContainText('src/HiddenTarget.ts');
});

test('a message opens the files this session changed, and leaves other code alone', async ({ page, cockpit }) => {
  writeChangedFiles(cockpit.registryDir, cockpit.agentDir);
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'files-status',
    method: 'setStatus',
    statusKey: 'doom-file-edit-files',
    statusText: '6 files',
  });
  await expect(page.getByTestId('activity-file-edits')).toContainText('src/Newest.ts');

  cockpit.session.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'text_delta',
      delta: 'Changed `src/Newest.ts` at `src/Newest.ts:12`; left `flex gap-3` and `src/Untouched.ts` alone.',
    },
  });

  const links = page.getByTestId('markdown-file-link');
  await expect(links).toHaveCount(2);
  await expect(links.nth(1)).toHaveText('src/Newest.ts:12');
  // A class name and a file this session never changed stay plain code.
  await expect(page.getByTestId('entry-assistant').locator('code')).toHaveCount(2);

  await links.first().click();
  await expect(page.getByTestId('files-file-panel')).toBeVisible();
  await expect(page.getByTestId('files-breadcrumb')).toContainText('src/Newest.ts');
});
