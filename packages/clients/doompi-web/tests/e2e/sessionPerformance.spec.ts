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
  await expect(page.getByTestId('entry-assistant')).toHaveCount(140);
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
      pendingProps?: { entry?: { id?: string }; text?: string };
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
            if (props?.entry?.id === 'perf-large-0-tool') work.tool += 1;
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
  await expect(page.getByTestId('entry-tool').first()).toBeVisible();
  expect((await renderWork(page)).versions).toContain('19.2.8');

  const heldScrollTop = await page.getByTestId('timeline').evaluate((element) => {
    if (element.scrollHeight <= element.clientHeight) throw new Error('The performance transcript must overflow.');
    element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
    return element.scrollTop;
  });

  const beforeStatus = await renderWork(page);
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
  await expect(page.getByTestId('timeline-jump')).toHaveCount(0);
  expect(await page.getByTestId('timeline').evaluate((element) => element.scrollTop)).toBe(heldScrollTop);

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
  await expect(page.getByTestId('timeline-jump')).toBeVisible();
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
