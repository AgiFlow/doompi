import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHeadlessHub, serveHeadlessServer, type HeadlessSessionHost } from '@agimon-ai/doompi-core/server';
import { readSyncRegistration } from '@agimon-ai/doompi-core/sync-registration';
import { createWebCompositions } from '@agimon-ai/doompi-core/web-compositions';
import { test as base } from '@playwright/test';

import { serveWeb } from '../../src/adapters/httpServer';
import { SYNCED_DIST_ENV, SYNCED_HOME_ENV } from './bundleSetup';
import { type HeadlessSession, startHeadlessSession } from './headlessSession';
import { startRunnerApiServer, type RunnerApiServer } from './runnerRuns';
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface CockpitFixture {
  /** Every headless session, in registration order. */
  sessions: HeadlessSession[];
  /** The first session, which the cockpit auto-focuses. */
  session: HeadlessSession;
  /** Isolated workflow-mcp home used by filesystem-backed plugin fixtures. */
  workflowHome: string;
  /** Isolated doom-runner store used by the runner package API fixture. */
  runnerStore: string;
  /** Isolated Pi agent directory used by settings and agent fixtures. */
  agentDir: string;
  /** Isolated temporary root shared by filesystem-backed plugin fixtures. */
  teamTemp: string;
  /** Publishes the current shell bytes as a fresh synchronized generation. */
  republishShell(): void;
  url: string;
}

interface CockpitOptions {
  sessionCount: number;
  assets: 'packaged' | 'synced';
  assetPackageRoot: string | null;
  backlogLimit: number;
}

export const test = base.extend<CockpitOptions & { cockpit: CockpitFixture }>({
  sessionCount: [1, { option: true }],
  assets: ['packaged', { option: true }],
  assetPackageRoot: [null, { option: true }],
  backlogLimit: [512, { option: true }],
  page: async ({ page, cockpit, assets }, use) => {
    if (assets === 'synced') {
      await page.addInitScript(() => {
        const root = document.documentElement;
        root.style.pointerEvents = 'none';
        const releaseWhenReady = (): boolean => {
          if (!document.querySelector('link[data-doompi-plugin-composition][media="all"]')) return false;
          root.style.removeProperty('pointer-events');
          return true;
        };
        if (!releaseWhenReady()) {
          const observer = new MutationObserver(() => {
            if (!releaseWhenReady()) return;
            observer.disconnect();
          });
          observer.observe(document, { attributes: true, childList: true, subtree: true });
        }
      });
    }
    await page.goto(cockpit.url);
    await page.getByTestId('cockpit').waitFor();
    await page.goto('about:blank');
    for (const session of cockpit.sessions) {
      const waitForAttach = session.waitForAttach.bind(session);
      session.waitForAttach = async (timeoutMs = 5000): Promise<void> => {
        await waitForAttach(timeoutMs);
        await page.locator('[data-testid="composer-input"]:not([disabled])').waitFor({ timeout: timeoutMs });
      };
    }
    await use(page);
  },
  cockpit: async ({ sessionCount, assets, assetPackageRoot }, use) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-e2e-'));
    const syncedDist = process.env[SYNCED_DIST_ENV];
    if (assets === 'synced' && (syncedDist === undefined || syncedDist === ''))
      throw new Error('global setup did not publish the synchronized web bundle');

    const workflowHome = path.join(root, 'workflow-mcp');
    const agentDir = path.join(root, 'pi-agent');
    const runnerStore = path.join(agentDir, 'doom-runner');
    const teamTemp = path.join(root, 'tmp');
    const workRoot = path.join(root, 'workspaces');
    fs.mkdirSync(workRoot, { recursive: true });
    fs.mkdirSync(teamTemp, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });

    const assetsDir = assets === 'synced' ? syncedDist! : path.join(assetPackageRoot ?? packageRoot, 'dist', 'web');
    const syncedHome = process.env[SYNCED_HOME_ENV];
    if (syncedHome === undefined || syncedHome === '')
      throw new Error('global setup did not publish its isolated home');
    const workspaceRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
    const registration = readSyncRegistration(workspaceRoot, syncedHome);
    if (registration?.webDirectory === null || registration?.webDirectory === undefined)
      throw new Error('global setup did not publish a web registration');
    const workspaceId = registration.identity.worktreeId;
    const webCompositions = createWebCompositions(path.join(root, 'web-compositions'), () => undefined);
    let shellGeneration = 0;
    const republishShell = (): void => {
      shellGeneration += 1;
      webCompositions.publishShell({
        ...registration,
        generation: `${registration.generation}-e2e-${String(shellGeneration)}`,
        webDirectory: assetsDir,
      });
    };
    republishShell();
    const globalComposition = webCompositions.publish({ scope: 'global' }, registration, []);
    const workspaceComposition = webCompositions.publish({ scope: 'workspace', workspaceId }, registration, []);
    if (globalComposition === undefined || workspaceComposition === undefined)
      throw new Error('global setup did not publish the E2E web compositions');
    const runnerServers = new Map<string, RunnerApiServer>();
    const hosts = new Map<string, HeadlessSessionHost>();
    const manager = {
      async create(): Promise<HeadlessSessionHost> {
        throw new Error('The Playwright headless fixture does not create sessions through HTTP.');
      },
      get: (id: string) => hosts.get(id),
      sessions: () => [...hosts.values()],
      async closeSession(id: string): Promise<void> {
        await hosts.get(id)?.dispose();
        hosts.delete(id);
      },
      async close(): Promise<void> {
        for (const host of hosts.values()) await host.dispose();
        hosts.clear();
      },
    };
    const hub = createHeadlessHub({
      manager,
      requestSessionApi: async (scope, request) => {
        const server = runnerServers.get(scope.sessionId);
        if (server === undefined) return Response.json({ error: 'Session API unavailable.' }, { status: 404 });
        const target = new URL(`/api/plugin/${request.basePath}${request.path}`, server.url);
        const body = request.body === undefined || request.body === null ? undefined : Buffer.from(request.body);
        return fetch(target, {
          method: request.method,
          ...(body === undefined ? {} : { body: body as unknown as BodyInit, duplex: 'half' as const }),
        });
      },
    });

    let headless = await serveHeadlessServer({
      headlessHub: hub,
      port: 0,
      token: 'e2e-headless-token',
      requestAsset: (request) => webCompositions.request(request),
      compositions: () => ({
        global: globalComposition,
        publicKey: webCompositions.publicKey(),
        shell: webCompositions.shellTrust(),
        workspaces: [{ id: workspaceId, root: workRoot, webComposition: workspaceComposition }],
      }),
    });
    const headlessUrl = (): string => headless.url;
    const restartHeadless = async (): Promise<void> => {
      const port = Number(new URL(headless.url).port);
      await headless.close();
      headless = await serveHeadlessServer({
        headlessHub: hub,
        port,
        token: 'e2e-headless-token',
        requestAsset: (request) => webCompositions.request(request),
        compositions: () => ({
          global: globalComposition,
          publicKey: webCompositions.publicKey(),
          shell: webCompositions.shellTrust(),
          workspaces: [{ id: workspaceId, root: workRoot, webComposition: workspaceComposition }],
        }),
      });
    };

    const sessions: HeadlessSession[] = [];
    for (let index = 0; index < sessionCount; index += 1) {
      const id = `s${index + 1}`;
      runnerServers.set(id, await startRunnerApiServer(runnerStore, id));
      sessions.push(
        await startHeadlessSession({
          id,
          name: `session-${index + 1}`,
          cwd: path.join(workRoot, id),
          workspaceId,
          webComposition:
            webCompositions.publish({ scope: 'session', sessionId: id }, registration, []) ??
            (() => {
              throw new Error(`global setup did not publish the '${id}' web composition`);
            })(),
          hub,
          headlessUrl,
          restartHeadless,
          onHost: (sessionId, host) => hosts.set(sessionId, host),
        }),
      );
    }

    const web = await serveWeb({
      port: 0,
      assetsDir,
      headlessUrl: headless.url,
      headlessToken: 'e2e-headless-token',
    });

    try {
      await use({
        sessions,
        session: sessions[0]!,
        workflowHome,
        runnerStore,
        agentDir,
        teamTemp,
        republishShell,
        url: web.url,
      });
    } finally {
      await web.close();
      await headless.close();
      for (const session of sessions) await session.close();
      for (const server of runnerServers.values()) await server.close();
      webCompositions.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
});

export { expect } from '@playwright/test';
