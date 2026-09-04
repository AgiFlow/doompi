import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test as base } from '@playwright/test';
import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config';
import { ensureDoomInitialized } from '../../src/adapters/doomInitialization.ts';
import { serveWeb } from '../../src/adapters/httpServer.ts';
import type { WebServer } from '../../src/types/bridge.ts';

const AUTH_ENV = /_API_KEY$|_AUTH_TOKEN$|_OAUTH_TOKEN$/u;

export interface RemoteListenerFixture {
  readonly localOrigin: string;
  readonly server: WebServer;
  tunnelOrigin(): string;
  localUrl(route: string): string;
  tunnelUrl(route: string): string;
  enable(): Promise<void>;
}

/**
 * Runs the real serveWeb app with its second listener pointed at itself.
 *
 * The launcher is deliberately only a URL reporter. serveWeb still owns the
 * tunnel listener, so requests reach the same guard and WebSocket stack as a
 * cloudflared connection without starting an external process.
 */
export const test = base.extend<{ remoteListener: RemoteListenerFixture }>({
  remoteListener: async ({ browserName: _browserName }, use) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-remote-e2e-')));
    const homeDir = path.join(root, 'home');
    const registryDir = path.join(root, 'run');
    const assetsDir = path.join(root, 'web');
    const stateDir = path.join(root, 'remote-state');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'index.html'), '<!doctype html><title>DoomPi test</title>');

    const environment: Record<string, string> = {
      HOME: homeDir,
      USERPROFILE: homeDir,
      PI_CODING_AGENT_DIR: path.join(homeDir, '.pi', 'agent'),
      WORKFLOW_MCP_HOME: path.join(root, 'workflow-mcp'),
    };
    const previousEnvironment = new Map<string, string | undefined>();
    for (const key of Object.keys(environment)) {
      previousEnvironment.set(key, process.env[key]);
      process.env[key] = environment[key];
    }
    const removedEnvironment = new Map<string, string | undefined>();
    for (const key of Object.keys(process.env)) {
      if (!key.startsWith('DOOMPI_')) continue;
      removedEnvironment.set(key, process.env[key]);
      delete process.env[key];
    }
    const removedSecrets: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(process.env)) {
      if (!AUTH_ENV.test(key) || value === undefined) continue;
      removedSecrets.push([key, value]);
      delete process.env[key];
    }

    let tunnelOriginValue: string | undefined;
    let server: WebServer | undefined;
    try {
      await ensureDoomInitialized({ homeDirectory: homeDir });
      // Keep the initializer's Pi integration, but avoid selecting the default
      // distribution packages: the first sync would otherwise reach npm from an
      // E2E fixture. Pairing does not depend on those packages.
      fs.writeFileSync(
        path.join(globalDoomConfigDirectory(homeDir), 'modes.yaml'),
        `default:
  packages: []
layers: {}
defaultMajorMode: minimal
majorMode:
  minimal:
    description: Minimal remote-access E2E fixture.
    layers: []
`,
      );
      server = await serveWeb({
        registryDir,
        spawnCommand: path.join(root, 'missing-doompi-server'),
        port: 0,
        host: '127.0.0.1',
        assetsDir,
        remoteStateDir: stateDir,
        browseRoot: root,
        remoteAccess: {
          launchTunnel: async ({ port, acceptOrigin }) => {
            const origin = `http://127.0.0.1:${String(port)}`;
            acceptOrigin?.(origin);
            tunnelOriginValue = origin;
            return { ok: true, publicOrigin: origin, stop: async () => {} };
          },
        },
      });

      const localOrigin = server.url;
      const fixture: RemoteListenerFixture = {
        localOrigin,
        server,
        tunnelOrigin() {
          if (tunnelOriginValue === undefined) throw new Error('The remote listener is not enabled.');
          return tunnelOriginValue;
        },
        localUrl(route) {
          return `${localOrigin}${route}`;
        },
        tunnelUrl(route) {
          return `${this.tunnelOrigin()}${route}`;
        },
        async enable() {
          const response = await fetch(`${localOrigin}/api/remote/enable`, { method: 'POST' });
          await response.arrayBuffer();
          if (!response.ok) throw new Error(`Could not enable the test tunnel: ${String(response.status)}`);
        },
      };
      await use(fixture);
    } finally {
      try {
        await server?.close();
      } finally {
        for (const [key, value] of removedSecrets) process.env[key] = value;
        for (const [key, value] of removedEnvironment) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        for (const [key, value] of previousEnvironment) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  },
});

export { expect } from '@playwright/test';
