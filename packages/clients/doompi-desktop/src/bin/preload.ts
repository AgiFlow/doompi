import { contextBridge, ipcRenderer } from 'electron';

/**
 * The entire desktop surface offered to the cockpit.
 *
 * Deliberately almost empty. The renderer loads the same loopback origin the
 * browser cockpit does, so everything it already knows how to do keeps working
 * with no desktop-specific code: `target="_blank"` is caught by the window's
 * open handler and sent to the real browser, and directory browsing is served
 * by the hub. What remains is the marker a future non-web client needs in order
 * to tell the targets apart, and the app version for support.
 *
 * Anything added here is privilege the cockpit does not have in a browser, so
 * it should earn its place against a concrete caller rather than be offered in
 * advance.
 */
const bridge = {
  platform: 'desktop' as const,
  version: (): Promise<string> => ipcRenderer.invoke('doompi:version') as Promise<string>,
};

contextBridge.exposeInMainWorld('doompiDesktop', bridge);

export type DoompiDesktopBridge = typeof bridge;
