import path from 'node:path';
import { BrowserWindow, shell } from 'electron';

const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;
const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;
const EXTERNAL_PROTOCOLS = new Set(['https:']);
const MACOS_TITLEBAR_CSS = '[data-doompi-session-rail-header] { padding-top: 3.5rem !important; }';

/**
 * Confines the window to the cockpit it was opened for.
 *
 * The renderer loads a network origin, so it is treated as one. Anything that
 * is not this cockpit either opens in the user's real browser, where it gets
 * the browser's own protections, or does not open at all.
 */
function confineNavigation(window: BrowserWindow, hubUrl: string): void {
  const hubOrigin = new URL(hubUrl).origin;

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_PROTOCOLS.has(new URL(url).protocol)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === hubOrigin) return;
    event.preventDefault();
    if (EXTERNAL_PROTOCOLS.has(new URL(url).protocol)) void shell.openExternal(url);
  });

  // A renderer that somehow attaches a webview would otherwise inherit this
  // window's preload and its bridge.
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

/** Opens the cockpit window against an already-serving hub. */
export function createMainWindow(input: { hubUrl: string; preloadPath: string }): BrowserWindow {
  const window = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.resolve(input.preloadPath),
      // The cockpit bootstraps through a service worker. An in-memory partition
      // gives each desktop launch the bundle shipped by that app version instead
      // of reviving a worker cached by an older installation.
      partition: 'doompi-desktop',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  confineNavigation(window, input.hubUrl);
  if (process.platform === 'darwin') {
    window.webContents.on('did-finish-load', () => void window.webContents.insertCSS(MACOS_TITLEBAR_CSS));
  }
  window.once('ready-to-show', () => window.show());
  void window.loadURL(input.hubUrl);
  return window;
}
