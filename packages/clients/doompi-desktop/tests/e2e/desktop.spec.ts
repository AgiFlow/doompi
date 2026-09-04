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

async function waitForMarker(markerPath: string, event: string): Promise<HubMarker> {
  const deadline = Date.now() + MARKER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const marker = readMarkers(markerPath).find((entry) => entry.event === event);
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
  const markers = readMarkers(markerPath);
  const started = markers.find((marker) => marker.event === 'started');
  const pid = started?.pid;
  if (!isSafePid(pid) || markers.some((marker) => marker.event === 'stopped' && marker.pid === pid)) return;
  if (!processIsAlive(pid)) return;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  const deadline = Date.now() + HUB_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const currentMarkers = readMarkers(markerPath);
    if (currentMarkers.some((marker) => marker.event === 'stopped' && marker.pid === pid)) return;
    if (!processIsAlive(pid)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, MARKER_POLL_MS));
  }

  if (!processIsAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }
}

const test = base.extend<{ desktop: DesktopFixture }>({
  desktop: async ({ browserName: _browserName }, use) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd-'));
    const home = path.join(root, 'home');
    const registryDirectory = path.join(root, 'run');
    const userDataDirectory = path.join(root, 'user-data');
    const markerPath = path.join(root, 'hub.jsonl');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(registryDirectory, { recursive: true });
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
          DOOMPI_RUNTIME_DIR: registryDirectory,
          DOOMPI_DESKTOP_E2E_HUB_ENTRY: fakeHubEntry,
          DESKTOP_E2E_HUB_MARKER: markerPath,
        },
      });
      appProcess = app.process();
      const page = await app.firstWindow();
      await expect(page.getByTestId('fake-hub')).toBeVisible();
      await waitForMarker(markerPath, 'started');
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

test('starts the desktop cockpit through the development fake hub seam', async ({ desktop }) => {
  await expect(desktop.page).toHaveTitle('DoomPi desktop fake hub');
  await expect(desktop.page.getByTestId('hub-status')).toHaveText('ready');
  expect(desktop.hubOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  expect(readMarkers(desktop.markerPath).map((marker) => marker.event)).toContain('started');
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

test('confines navigation to the fake hub origin', async ({ desktop }) => {
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

test('stops the fake hub before clean Electron shutdown', async ({ desktop }) => {
  const started = await waitForMarker(desktop.markerPath, 'started');
  expect(started.pid).toEqual(expect.any(Number));

  await desktop.app.close();
  await waitForMarker(desktop.markerPath, 'stopped');

  expect(readMarkers(desktop.markerPath).map((marker) => marker.event)).toEqual(['started', 'stopping', 'stopped']);
  expect(desktop.process.exitCode).toBe(0);
});
