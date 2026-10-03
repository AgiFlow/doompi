import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../support/cockpit';
import {
  performanceEntries,
  PERFORMANCE_BACKLOG_LIMIT,
  PERFORMANCE_MARKERS,
  seedPerformanceSession,
} from '../support/performanceFixture';

// Test-only inputs: normal regression runs use the current packaged build.
const snapshotRoot = process.env.DOOMPI_PERFORMANCE_PACKAGE_ROOT ?? null;
const readyFile = process.env.DOOMPI_PERFORMANCE_READY;
test.use({ sessionCount: 2, backlogLimit: PERFORMANCE_BACKLOG_LIMIT, assetPackageRoot: snapshotRoot });

type RenderWork = { markdown: number; streaming: number; tool: number; versions: string[] };

async function renderWork(page: import('@playwright/test').Page): Promise<RenderWork> {
  return page.evaluate(() => (window as unknown as { __doomRenderWork: RenderWork }).__doomRenderWork);
}

async function scrollToOldestTurn(page: import('@playwright/test').Page): Promise<void> {
  const timeline = page.getByTestId('timeline');
  const oldest = page.getByTestId('entry-assistant').filter({ hasText: 'Fixture turn 0' });
  const tool = page.getByTestId('entry-tool').first();
  await expect
    .poll(
      async () => {
        await timeline.evaluate((element) => {
          element.scrollTop = 0;
          element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
          element.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        return (await oldest.isVisible()) && (await tool.isVisible());
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

test('switches fixed large and small transcripts without losing their contents', async ({ page, cockpit }) => {
  seedPerformanceSession(cockpit.sessions[0], 'large');
  seedPerformanceSession(cockpit.sessions[1], 'small');
  await page.goto(cockpit.url);
  await expect(page.getByTestId('entry-assistant').filter({ hasText: PERFORMANCE_MARKERS.large })).toBeVisible();
  await page.getByTestId('session-card-s2').click();
  await expect(page.getByTestId('entry-assistant').filter({ hasText: PERFORMANCE_MARKERS.small })).toBeVisible();
  await expect(page.getByTestId('entry-assistant').filter({ hasText: PERFORMANCE_MARKERS.large })).toHaveCount(0);
  await page.getByTestId('session-card-s1').click();
  await expect(page.getByTestId('entry-assistant').filter({ hasText: PERFORMANCE_MARKERS.large })).toBeVisible();
  await scrollToOldestTurn(page);
});

test('status updates preserve mounted Markdown and scroll while invalidating tool renderers', async ({
  page,
  cockpit,
}) => {
  seedPerformanceSession(cockpit.session, 'large');
  await page.addInitScript(() => {
    type Fiber = {
      child: Fiber | null;
      flags: number;
      pendingProps?: { entry?: { toolCallId?: string }; text?: string };
      sibling: Fiber | null;
      type?: unknown;
    };
    type Root = { current: Fiber };
    const work = { markdown: 0, streaming: 0, tool: 0, versions: [] as string[] };
    let previousFibers = new WeakSet<Fiber>();
    (window as unknown as { __doomRenderWork: typeof work }).__doomRenderWork = work;
    (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      inject(renderer: { version?: string }) {
        if (renderer.version) work.versions.push(renderer.version);
        return 1;
      },
      onCommitFiberRoot(_rendererId: number, root: Root) {
        const committedFibers = new WeakSet<Fiber>();
        const visit = (fiber: Fiber | null): void => {
          if (fiber === null) return;
          committedFibers.add(fiber);
          const props = fiber.pendingProps;
          // A bailed-out subtree can reuse the previous fiber with its old PerformedWork flag.
          // Count only fresh work-in-progress fibers committed this time.
          if (!previousFibers.has(fiber) && (fiber.flags & 1) !== 0 && typeof fiber.type === 'function') {
            if (props?.entry?.toolCallId === 'perf-large-0-tool') work.tool += 1;
            if (props?.text?.includes('PERF_LARGE_READY')) work.markdown += 1;
            if (props?.text?.startsWith('STREAM_RENDER_MARKER')) work.streaming += 1;
          }
          visit(fiber.child);
          visit(fiber.sibling);
        };
        visit(root.current);
        previousFibers = committedFibers;
      },
      onCommitFiberUnmount() {},
    };
  });

  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await expect(page.getByTestId('entry-assistant').filter({ hasText: PERFORMANCE_MARKERS.large })).toBeVisible();
  await scrollToOldestTurn(page);
  await expect(page.getByTestId('entry-tool').first()).toBeVisible();
  expect((await renderWork(page)).versions).toContain('19.3.0');

  const heldScrollTop = await page.getByTestId('timeline').evaluate((element) => {
    if (element.scrollHeight <= element.clientHeight) throw new Error('The performance transcript must overflow.');
    return element.scrollTop;
  });

  const beforeStatus = await renderWork(page);
  const beforeJumpCount = await page.getByTestId('timeline-jump').count();
  expect(beforeStatus.markdown).toBeGreaterThan(0);
  expect(beforeStatus.tool).toBeGreaterThan(0);
  cockpit.session.emit({
    type: 'extension_ui_request',
    method: 'setStatus',
    statusKey: 'doom-major-mode',
    statusText: '[copilot]',
  });
  await expect(page.getByTestId('selection-mode')).toHaveText('COPILOT');

  const afterStatus = await renderWork(page);
  expect(afterStatus.markdown).toBe(beforeStatus.markdown);
  expect(afterStatus.tool).toBeGreaterThan(beforeStatus.tool);
  await expect(page.getByTestId('timeline-jump')).toHaveCount(beforeJumpCount);
  expect(await page.getByTestId('timeline').evaluate((element) => element.scrollTop)).toBe(heldScrollTop);

  // Keep the live tail mounted while remaining far enough away for the jump affordance.
  await page.getByTestId('timeline').evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight - 100;
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  cockpit.session.emit({ type: 'agent_start' });
  cockpit.session.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'STREAM_RENDER_MARKER first' },
  });
  await expect(page.getByTestId('entry-assistant').last()).toContainText('STREAM_RENDER_MARKER first');
  const beforeStreamChange = await renderWork(page);

  cockpit.session.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: ' second' },
  });
  await expect(page.getByTestId('entry-assistant').last()).toContainText('STREAM_RENDER_MARKER first second');
  expect((await renderWork(page)).streaming).toBeGreaterThan(beforeStreamChange.streaming);
});

async function expectMountedGeometry(page: import('@playwright/test').Page): Promise<void> {
  await expect
    .poll(async () =>
      page
        .getByTestId('timeline')
        .locator('[data-index]')
        .evaluateAll((elements) => {
          const rows = elements
            .map((element) => ({
              index: Number(element.getAttribute('data-index')),
              rect: element.getBoundingClientRect(),
              content: element.firstElementChild?.getBoundingClientRect(),
              padding: parseFloat(getComputedStyle(element).paddingBottom),
            }))
            .sort((a, b) => a.index - b.index);
          if (rows.length < 2) return ['Too few mounted rows'];
          const errors: string[] = [];
          for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index]!;
            if (!row.content || row.content.height <= 0) errors.push(`Empty row ${row.index}`);
            else if (Math.abs(row.rect.bottom - row.content.bottom - row.padding) > 1)
              errors.push(`Internal excess gap in row ${row.index}`);
            const previous = rows[index - 1];
            // Only adjacent mounted units: virtualized leading/trailing space is intentional.
            if (previous && row.index === previous.index + 1 && Math.abs(row.rect.top - previous.rect.bottom) > 1)
              errors.push(`Overlap or gap between ${previous.index} and ${row.index}`);
          }
          return errors;
        }),
    )
    .toEqual([]);
}

test('journal-first completion and shared settlement keep unique mounted rows', async ({ page, cockpit }) => {
  const duplicateKeys: string[] = [];
  page.on('console', (message) => {
    if (/same key|unique.*key/i.test(message.text())) duplicateKeys.push(message.text());
  });
  cockpit.session.replaceEntries(performanceEntries('small'));
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await expect(page.getByTestId('entry-assistant').filter({ hasText: PERFORMANCE_MARKERS.small })).toBeVisible();
  const message = {
    id: 'geometry-completion',
    role: 'assistant',
    content: [{ type: 'text', text: 'GEOMETRY_COMPLETION\n\n' + 'A tall completed paragraph. '.repeat(80) }],
  };
  const runId = 'geometry-run';
  const completion = { id: message.id, type: 'message', message };
  const settlement = {
    id: 'geometry-settlement',
    type: 'custom',
    customType: 'doompi.agent-settled',
    data: { runId, tools: 0 },
  };
  // message_end refreshes the paged durable transcript, so its journal must agree.
  cockpit.session.replaceEntries([...performanceEntries('small'), completion, settlement]);
  cockpit.session.emit({ type: 'agent_start' });
  cockpit.session.emit({ type: 'message_start', message: { ...message, content: [] } });
  cockpit.session.emit({ type: 'entry_appended', entry: { id: message.id, type: 'message', message } });
  cockpit.session.emit({ type: 'message_end', entryId: message.id, message });
  cockpit.session.emit({ type: 'message_end', entryId: message.id, message });
  cockpit.session.emit({
    type: 'entry_appended',
    entry: {
      id: 'geometry-settlement',
      type: 'custom',
      customType: 'doompi.agent-settled',
      data: { runId, tools: 0 },
    },
  });
  cockpit.session.emit({ type: 'agent_settled', runId });
  await expect(page.getByTestId('entry-assistant').filter({ hasText: 'GEOMETRY_COMPLETION' })).toHaveCount(1);
  await page.getByTestId('timeline').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  // At the live tail, the shared journal/live run contributes exactly one marker.
  await expect(page.getByTestId('entry-settled')).toHaveCount(1);
  await expect(page.getByTestId('entry-settled')).toBeVisible();
  await expectMountedGeometry(page);
  expect(duplicateKeys).toEqual([]);
});

test('aggregate streaming and same durable IDs across sessions remeasure mounted geometry', async ({
  page,
  cockpit,
}) => {
  const duplicateKeys: string[] = [];
  page.on('console', (message) => {
    if (/same key|unique.*key/i.test(message.text())) duplicateKeys.push(message.text());
  });
  const short = performanceEntries('small');
  const tall = short.map((entry) => {
    const message = entry.message as { role: string; content: unknown[] };
    return message.role === 'assistant'
      ? {
          ...entry,
          message: {
            ...message,
            content: [
              { type: 'text', text: 'TALL_SESSION\n\n' + 'Different height for the same durable ID. '.repeat(100) },
            ],
          },
        }
      : entry;
  });
  cockpit.sessions[0].replaceEntries(short);
  cockpit.sessions[1].replaceEntries(tall);
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await expect(page.getByTestId('entry-assistant').filter({ hasText: PERFORMANCE_MARKERS.small })).toBeVisible();
  await expectMountedGeometry(page);
  await page.getByTestId('session-card-s2').click();
  await expect(page.getByTestId('entry-assistant').last()).toContainText('TALL_SESSION');
  await expectMountedGeometry(page);
  await page.getByTestId('session-card-s1').click();
  await expect(page.getByTestId('entry-assistant').last()).toContainText(PERFORMANCE_MARKERS.small);
  await expectMountedGeometry(page);
  cockpit.session.emit({ type: 'agent_start' });
  cockpit.session.emit({ type: 'message_start', message: { id: 'geometry-stream', role: 'assistant', content: [] } });
  for (const text of ['AGGREGATE_SHORT', '\n\nAGGREGATE_TALL\n\n' + 'Streaming changes row height. '.repeat(100)]) {
    // The existing fixture supplies both the delta and the accumulated message.
    cockpit.session.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: text },
    });
    await expect(page.getByTestId('entry-assistant').last()).toContainText(text.trim().split('\n')[0]!);
    await expectMountedGeometry(page);
  }
  await expect(page.getByTestId('entry-assistant').last()).toContainText('AGGREGATE_SHORT');
  expect(duplicateKeys).toEqual([]);
});

test('serves an opt-in production fixture for Playwriter profiling', async ({ cockpit }) => {
  test.skip(readyFile === undefined, 'Set DOOMPI_PERFORMANCE_READY to hold an isolated profiling server.');
  if (readyFile === undefined) return;
  if (snapshotRoot === null) throw new Error('Manual profiling requires an immutable DOOMPI_PERFORMANCE_PACKAGE_ROOT.');
  test.setTimeout(0);
  seedPerformanceSession(cockpit.sessions[0], 'large');
  seedPerformanceSession(cockpit.sessions[1], 'small');
  const destination = path.resolve(readyFile);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const stopFile = `${destination}.stop`;
  if (fs.existsSync(stopFile)) throw new Error('Choose a fresh performance ready-file path for this profiling run.');
  // Creating stopFile releases the fixture through normal Playwright cleanup.
  const stopped = new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(path.dirname(destination), () => {
      if (fs.existsSync(stopFile)) {
        watcher.close();
        resolve();
      }
    });
    watcher.once('error', (error) => {
      watcher.close();
      reject(error);
    });
  });
  fs.writeFileSync(
    destination,
    JSON.stringify(
      {
        url: cockpit.url,
        packageRoot: snapshotRoot,
        sessions: ['s1', 's2'],
        markers: PERFORMANCE_MARKERS,
        logicalInputSha256: createHash('sha256')
          .update(JSON.stringify([performanceEntries('large'), performanceEntries('small')]))
          .digest('hex'),
        stopFile,
      },
      null,
      2,
    ),
  );
  await stopped;
});
