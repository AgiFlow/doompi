import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const mainEntry = path.join(packageRoot, 'dist', 'bin', 'main.cjs');
const fakeHubEntry = path.join(packageRoot, 'tests', 'fixtures', 'fakeHub.mjs');
const MARKER_TIMEOUT_MS = 10_000;
const MARKER_POLL_MS = 25;
const HUB_STOP_TIMEOUT_MS = 2_000;
interface HubMarker {
  readonly event: string;
  readonly pid?: number;
  readonly role?: string;
  readonly message?: string;
}

interface DesktopFixture {
  readonly app: ElectronApplication;
  readonly process: ChildProcess;
  readonly page: Page;
  readonly markerPath: string;
  readonly hubOrigin: string;
}

function readMarkers(markerPath: string): HubMarker[] {
  if (!fs.existsSync(markerPath)) return [];
  return fs
    .readFileSync(markerPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HubMarker);
}

async function waitForMarker(markerPath: string, event: string, role?: string): Promise<HubMarker> {
  const deadline = Date.now() + MARKER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const marker = readMarkers(markerPath).find(
      (entry) => entry.event === event && (role === undefined || entry.role === role),
    );
    if (marker !== undefined) return marker;
    await new Promise<void>((resolve) => setTimeout(resolve, MARKER_POLL_MS));
  }
  throw new Error(`Timed out waiting for fake hub marker ${event} in ${markerPath}`);
}

function isSafePid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopFakeHub(markerPath: string): Promise<void> {
  const started = readMarkers(markerPath).filter((marker) => marker.event === 'started' && isSafePid(marker.pid));
  for (const marker of started) {
    const pid = marker.pid as number;
    if (readMarkers(markerPath).some((entry) => entry.event === 'stopped' && entry.pid === pid)) continue;
    if (!processIsAlive(pid)) continue;

    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      continue;
    }
    const deadline = Date.now() + HUB_STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const currentMarkers = readMarkers(markerPath);
      if (currentMarkers.some((entry) => entry.event === 'stopped' && entry.pid === pid)) break;
      if (!processIsAlive(pid)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, MARKER_POLL_MS));
    }

    if (!processIsAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process exited between the liveness check and the kill.
    }
  }
}

const test = base.extend<{ desktop: DesktopFixture }>({
  desktop: async ({ browserName: _browserName }, use) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd-'));
    const home = path.join(root, 'home');
    const userDataDirectory = path.join(root, 'user-data');
    const markerPath = path.join(root, 'hub.jsonl');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(userDataDirectory, { recursive: true });

    let app: ElectronApplication | undefined;
    let appProcess: ChildProcess | undefined;
    try {
      app = await electron.launch({
        args: [mainEntry, `--user-data-dir=${userDataDirectory}`],
        cwd: packageRoot,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          DOOMPI_DESKTOP_E2E_HUB_ENTRY: fakeHubEntry,
          DOOMPI_DESKTOP_E2E_HEADLESS_ENTRY: fakeHubEntry,
          DESKTOP_E2E_HUB_MARKER: markerPath,
        },
      });
      appProcess = app.process();
      const page = await app.firstWindow();
      await expect(page.getByTestId('fake-hub')).toBeVisible();
      await waitForMarker(markerPath, 'started', 'headless');
      await waitForMarker(markerPath, 'started', 'web');
      await use({ app, process: appProcess, page, markerPath, hubOrigin: new URL(page.url()).origin });
    } finally {
      try {
        if (
          app !== undefined &&
          appProcess !== undefined &&
          appProcess.exitCode === null &&
          appProcess.signalCode === null
        ) {
          await app.close();
        }
      } finally {
        try {
          await stopFakeHub(markerPath);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    }
  },
});

test('starts the desktop headless server and web proxy through the development seam', async ({ desktop }) => {
  await expect(desktop.page).toHaveTitle('DoomPi desktop fake hub');
  await expect(desktop.page.getByTestId('hub-status')).toHaveText('ready');
  expect(desktop.hubOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  expect(readMarkers(desktop.markerPath).map((marker) => marker.role)).toEqual(['headless', 'web']);
});

test('keeps the preload sandboxed while exposing the desktop bridge', async ({ desktop }) => {
  const bridge = await desktop.page.evaluate(async () => {
    const globals = globalThis as typeof globalThis & {
      doompiDesktop?: { platform: string; version: () => Promise<string> };
      process?: unknown;
      require?: unknown;
    };
    return {
      platform: globals.doompiDesktop?.platform,
      version: await globals.doompiDesktop?.version(),
      processType: typeof globals.process,
      requireType: typeof globals.require,
    };
  });

  const electronVersion = await desktop.app.evaluate(({ app: electronApp }) => electronApp.getVersion());
  expect(bridge).toMatchObject({
    platform: 'desktop',
    processType: 'undefined',
    requireType: 'undefined',
  });
  expect(bridge.version).toBe(electronVersion);
});

test('confines navigation to the web proxy origin', async ({ desktop }) => {
  const homeUrl = desktop.page.url();
  await desktop.page.getByTestId('same-origin-link').click();
  await expect(desktop.page.getByTestId('same-origin-page')).toBeVisible();
  expect(new URL(desktop.page.url()).origin).toBe(desktop.hubOrigin);

  await desktop.page.goto(homeUrl);
  await desktop.page.evaluate(() => {
    window.location.href = 'http://outside.invalid/blocked';
  });
  await desktop.page.waitForTimeout(150);
  expect(desktop.page.url()).toBe(homeUrl);

  const opened = await desktop.page.evaluate(() => window.open('http://outside.invalid/window'));
  expect(opened).toBeNull();
  expect(desktop.app.windows()).toHaveLength(1);
});

test('stops the web proxy and headless server before clean Electron shutdown', async ({ desktop }) => {
  const started = readMarkers(desktop.markerPath).filter((marker) => marker.event === 'started');
  expect(started).toHaveLength(2);
  expect(started.every((marker) => isSafePid(marker.pid))).toBe(true);

  await desktop.app.close();
  for (const marker of started) await waitForMarker(desktop.markerPath, 'stopped', marker.role);

  const events = readMarkers(desktop.markerPath).map((marker) => marker.event);
  expect(events.filter((event) => event === 'started')).toHaveLength(2);
  expect(events.filter((event) => event === 'stopping')).toHaveLength(2);
  expect(events.filter((event) => event === 'stopped')).toHaveLength(2);
  expect(desktop.process.exitCode).toBe(0);
});
