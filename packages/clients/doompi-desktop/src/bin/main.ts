import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { freePort, portIsFree, startHub } from '../adapters/hubProcess.ts';
import { createMainWindow, showCockpit } from '../adapters/mainWindow.ts';
import { assertSocketHeadroom, DEFAULT_PORT, hubEntry, LOOPBACK_HOST } from '../services/hubLaunch.ts';
import type { RunningHub } from '../types/hub.ts';

const EXTERNAL_PROTOCOLS = new Set(['https:']);

let hub: RunningHub | undefined;

function notice(message: string): void {
  if (message !== '') process.stderr.write(`[doompi-desktop] ${message}\n`);
}

/**
 * The session registry stays in the home directory, not in the app's own
 * storage.
 *
 * The reason is that this app and the `doompi` CLI are one program over one
 * registry: a session started here should be visible from a terminal, and the
 * reverse. Using `app.getPath('userData')` would split them in two.
 *
 * It also keeps the unix socket budget comfortable. Application Support does
 * usually fit inside the 104-byte `sun_path` cap, so this is a margin argument
 * rather than an impossibility one, which is why the check below is a
 * measurement instead of a rule against a particular directory.
 */
function registryDirectory(): string {
  const configured = process.env.DOOMPI_RUNTIME_DIR;
  return configured !== undefined && configured !== '' ? configured : path.join(os.homedir(), '.doompi', 'run');
}

function startupIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'startup-icon.png')
    : path.resolve(app.getAppPath(), '..', 'doompi-web', 'src', 'web', 'public', 'icon-512.png');
}

/** Allows local E2E runs to replace the staged hub without weakening packaged startup. */
function launchHubEntry(): string {
  const developmentEntry = process.env.DOOMPI_DESKTOP_E2E_HUB_ENTRY;
  if (!app.isPackaged && developmentEntry !== undefined && developmentEntry !== '') return developmentEntry;
  return hubEntry({
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged,
    projectRoot: app.getAppPath(),
  });
}
/** The default port when it is usable, so pairing keeps a stable origin. */
async function resolvePort(): Promise<number> {
  if (await portIsFree(LOOPBACK_HOST, DEFAULT_PORT)) return DEFAULT_PORT;
  return await freePort(LOOPBACK_HOST);
}

function registerBridgeHandlers(): void {
  ipcMain.handle('doompi:version', () => app.getVersion());

  ipcMain.handle('doompi:open-external', async (_event, url: unknown) => {
    if (typeof url !== 'string') return false;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) return false;
    await shell.openExternal(parsed.toString());
    return true;
  });

  ipcMain.handle('doompi:choose-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? undefined : result.filePaths[0];
  });
}

async function start(): Promise<void> {
  const preloadPath = path.join(__dirname, 'preload.cjs');
  const window = createMainWindow({ preloadPath, startupIconPath: startupIconPath() });
  const registryDir = registryDirectory();
  assertSocketHeadroom(registryDir);

  hub = await startHub(
    {
      entry: launchHubEntry(),
      host: LOOPBACK_HOST,
      port: await resolvePort(),
      registryDir,
      cwd: os.homedir(),
    },
    notice,
  );

  if (!window.isDestroyed()) showCockpit(window, hub.url);
}

// A second launch has to reach the first one: two cockpits over one session
// registry would compete for the same sessions.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing === undefined) return;
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  });

  app.whenReady().then(
    async () => {
      registerBridgeHandlers();
      try {
        await start();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notice(message);
        dialog.showErrorBox('DoomPi could not start', message);
        app.quit();
      }
    },
    (error: unknown) => {
      notice(error instanceof Error ? error.message : String(error));
      app.quit();
    },
  );

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && hub !== undefined) {
      createMainWindow({
        hubUrl: hub.url,
        preloadPath: path.join(__dirname, 'preload.cjs'),
        startupIconPath: startupIconPath(),
      });
    }
  });

  // macOS keeps an app alive with no windows; the cockpit is the app here, so
  // closing the window means the user is done and the hub should go with it.
  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    if (hub === undefined) return;
    const stopping = hub;
    hub = undefined;
    event.preventDefault();
    void stopping.stop().finally(() => app.quit());
  });
}
