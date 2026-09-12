import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDoomConfig } from '@agimon-ai/doompi-config';
import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItem, shell } from 'electron';
import { createMacOsComputerUseBackend } from '../adapters/macos/computerUseBackend';
import { freePort, portIsFree, startHub } from '../adapters/hubProcess';
import { createMainWindow, showCockpit } from '../adapters/mainWindow';
import { ComputerUseHost } from '../services/computerUseHost';
import { DEFAULT_HEADLESS_PORT, DEFAULT_PORT, headlessEntry, hubEntry, LOOPBACK_HOST } from '../services/hubLaunch';
import type { RunningHub } from '../types/hub';

const EXTERNAL_PROTOCOLS = new Set(['https:']);

let hub: RunningHub | undefined;

function notice(message: string): void {
  if (message !== '') process.stderr.write(`[doompi-desktop] ${message}\n`);
}

function startupIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'startup-icon.png')
    : path.resolve(app.getAppPath(), '..', 'doompi-web', 'src', 'web', 'public', 'icon-512.png');
}

/** Allows local E2E runs to replace the staged presentation without weakening packaged startup. */
function launchHubEntry(): string {
  const developmentEntry = process.env.DOOMPI_DESKTOP_E2E_HUB_ENTRY;
  if (!app.isPackaged && developmentEntry !== undefined && developmentEntry !== '') return developmentEntry;
  return hubEntry({
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged,
    projectRoot: app.getAppPath(),
  });
}

/** Allows local E2E runs to replace the staged headless process without weakening packaged startup. */
function launchHeadlessEntry(): string {
  const developmentEntry = process.env.DOOMPI_DESKTOP_E2E_HEADLESS_ENTRY;
  if (!app.isPackaged && developmentEntry !== undefined && developmentEntry !== '') return developmentEntry;
  return headlessEntry({
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged,
    projectRoot: app.getAppPath(),
  });
}

function headlessCredential(): { token: string; tokenFile: string; cleanup: () => void } {
  const token = randomUUID();
  const tokenFile = path.join(app.getPath('userData'), 'headless-token');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
  return {
    token,
    tokenFile,
    cleanup: () => fs.rmSync(tokenFile, { force: true }),
  };
}

/** The default port when it is usable, so pairing keeps a stable origin. */
async function resolvePort(defaultPort: number): Promise<number> {
  if (await portIsFree(LOOPBACK_HOST, defaultPort)) return defaultPort;
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
  const computerUseHost =
    app.isPackaged && process.platform === 'darwin'
      ? new ComputerUseHost({
          backend: createMacOsComputerUseBackend(),
          hostGeneration: randomUUID(),
          now: Date.now,
          newId: randomUUID,
          enabled: () => loadDoomConfig(os.homedir(), os.homedir()).computerUse?.enabled === true,
          confirmLocalActivation: async ({ applicationName, windowTitle, durationSeconds }) => {
            const result = await dialog.showMessageBox(window, {
              type: 'warning',
              title: 'Confirm computer control',
              message: `Allow DoomPi to control ${applicationName}?`,
              detail: `Window: ${windowTitle}\nDuration: ${String(durationSeconds)} seconds\n\nOnly the current agent session receives control.`,
              buttons: ['Allow', 'Cancel'],
              defaultId: 1,
              cancelId: 1,
              noLink: true,
            });
            return result.response === 0;
          },
        })
      : undefined;
  if (computerUseHost !== undefined) {
    const menu = Menu.getApplicationMenu() ?? new Menu();
    menu.append(
      new MenuItem({
        label: 'Computer Use',
        submenu: [
          {
            label: 'Stop Computer Use',
            accelerator: 'CmdOrCtrl+Shift+Escape',
            click: () => void computerUseHost.stopActive().catch((error: unknown) => notice(String(error))),
          },
        ],
      }),
    );
    Menu.setApplicationMenu(menu);
  }

  const credential = headlessCredential();
  try {
    const started = await startHub(
      {
        entry: launchHubEntry(),
        headlessEntry: launchHeadlessEntry(),
        host: LOOPBACK_HOST,
        port: await resolvePort(DEFAULT_PORT),
        headlessPort: await resolvePort(DEFAULT_HEADLESS_PORT),
        tokenFile: credential.tokenFile,
        token: credential.token,
        cwd: os.homedir(),
      },
      notice,
      computerUseHost,
    );
    hub = {
      ...started,
      stop: async () => {
        try {
          await started.stop();
        } finally {
          credential.cleanup();
        }
      },
    };
  } catch (error) {
    credential.cleanup();
    throw error;
  }

  if (!window.isDestroyed() && hub !== undefined) showCockpit(window, hub.url);
}

// A second launch is already prevented by the single-instance lock.
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
