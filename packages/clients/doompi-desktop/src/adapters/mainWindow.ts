import path from 'node:path';
import { BrowserWindow, nativeImage, shell } from 'electron';

const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;
const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;
const EXTERNAL_PROTOCOLS = new Set(['https:']);
const MACOS_TITLEBAR_CSS = '[data-doompi-session-rail-header] { padding-top: 3.5rem !important; }';
function startupPage(iconPath: string): string {
  const iconUrl = nativeImage.createFromPath(path.resolve(iconPath)).resize({ width: 72, height: 72 }).toDataURL();
  return `data:text/html;charset=UTF-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DoomPi is starting</title>
  <style>
    :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #f4efff; background: radial-gradient(circle at 50% 35%, #352355 0, #17131f 38%, #0b0910 75%); }
    main { display: grid; justify-items: center; gap: 18px; padding: 40px; text-align: center; }
    .mark { width: 72px; height: 72px; border-radius: 18px; box-shadow: 0 18px 60px #0009; }
    h1 { margin: 4px 0 0; font-size: 24px; letter-spacing: .02em; }
    p { max-width: 520px; margin: 0; color: #bcb4c9; font-size: 14px; line-height: 1.6; }
    .spinner { width: 24px; height: 24px; border: 2px solid #563d72; border-top-color: #cf9cff; border-radius: 50%; animation: spin .8s linear infinite; }
    .time { color: #8f859d; font-size: 12px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; border-color: #cf9cff; } }
  </style>
</head>
<body>
  <main role="status" aria-live="polite">
    <img class="mark" src="${iconUrl}" alt="">
    <h1>Preparing your workspace</h1>
    <div class="spinner" aria-hidden="true"></div>
    <p>DoomPi is syncing packages and building the local cockpit.</p>
    <p class="time">Initial synchronization can take several minutes.</p>
  </main>
</body>
</html>`)}`;
}

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

/** Opens a window immediately, then optionally loads an already-serving cockpit. */
export function createMainWindow(input: {
  preloadPath: string;
  startupIconPath: string;
  hubUrl?: string;
}): BrowserWindow {
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

  if (process.platform === 'darwin') {
    window.webContents.on('did-finish-load', () => void window.webContents.insertCSS(MACOS_TITLEBAR_CSS));
  }
  window.once('ready-to-show', () => window.show());
  if (input.hubUrl === undefined) void window.loadURL(startupPage(input.startupIconPath));
  else showCockpit(window, input.hubUrl);
  return window;
}

/** Replaces the startup scene with the serving cockpit. */
export function showCockpit(window: BrowserWindow, hubUrl: string): void {
  confineNavigation(window, hubUrl);
  void window.loadURL(hubUrl);
}
