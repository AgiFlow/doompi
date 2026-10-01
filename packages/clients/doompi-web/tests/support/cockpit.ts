import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { OpenSessionRecord } from '@agimon-ai/doompi-core/history';
import { type DoomHubSessionCreateRequest, type DoomPendingSessionSetup } from '@agimon-ai/doompi-core/hubChannel';
import { type PackageApiServer, serveSessionApis } from '@agimon-ai/doompi-core/packageApiServer';
import { createHeadlessHub, serveHeadlessServer, type HeadlessSessionHost } from '@agimon-ai/doompi-core/server';
import { loadServerBundle, resolveServerBundleSource } from '@agimon-ai/doompi-core/serverFacet';
import type { TranscriptPage, TranscriptPageRequest } from '@agimon-ai/doompi-core/sessionProtocol';
import { readSyncRegistration } from '@agimon-ai/doompi-core/syncRegistration';
import { createWebCompositions } from '@agimon-ai/doompi-core/webCompositions';
import { test as base } from '@playwright/test';

import { serveWeb } from '../../src/adapters/httpServer';
import { SYNCED_DIST_ENV, SYNCED_HOME_ENV } from './bundleSetup';
import { type HeadlessSession, startHeadlessSession } from './headlessSession';
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
/** Fixture-scoped stand-in for the production attach token, shared by the hub, the headless server, and the web adapter. */
const E2E_HEADLESS_TOKEN = 'e2e-headless-token';

export interface CockpitFixture {
  /** Every headless session, in registration order. */
  sessions: HeadlessSession[];
  workspaces: { id: string; root: string }[];
  /** Holds the next verified manifest request for a session until explicitly released. */
  holdSessionComposition(sessionId: string): { requested: Promise<void>; release(): void };
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
  /** Publishes fixture-owned session channel state through the hub event bus. */
  publishSessionEvent(type: string, sessionId: string, payload: unknown): void;
  publishPendingSetups(sessionId: string, pending: readonly DoomPendingSessionSetup[]): void;
  channels: readonly string[];
  /** Number of synchronized plugin styles loaded for the focused session. */
  pluginStyleCount: number;
  /** Publishes the current shell bytes as a fresh synchronized generation. */
  republishShell(): void;
  url: string;
}

interface CockpitOptions {
  sessionCount: number;
  workspaceCount: number;
  /** Recorded sessions the fixture offers as dormant, as a restarted server would. */
  dormantSessionCount: number;
  assets: 'packaged' | 'synced';
  assetPackageRoot: string | null;
  backlogLimit: number;
  /** Makes the workspace a git repository with a local branch and a remote-only branch. */
  gitWorkspace: boolean;
}

/** A repository on main with `feature/existing`, and an origin holding the remote-only branch `remote-only`. */
function initializeGitWorkspace(root: string, workRoot: string): void {
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  };
  git(workRoot, 'init', '-q', '-b', 'main');
  git(workRoot, 'config', 'user.email', 'e2e@example.com');
  git(workRoot, 'config', 'user.name', 'E2E');
  git(workRoot, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(workRoot, 'README.md'), '# e2e\n');
  git(workRoot, 'add', 'README.md');
  git(workRoot, 'commit', '-q', '-m', 'init');
  git(workRoot, 'branch', 'feature/existing');
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(workRoot, 'remote', 'add', 'origin', origin);
  git(workRoot, 'push', '-q', 'origin', 'main');
  git(workRoot, 'push', '-q', 'origin', 'main:remote-only');
  git(workRoot, 'fetch', '-q', 'origin');
  git(workRoot, 'remote', 'set-head', 'origin', 'main');
}

export const test = base.extend<CockpitOptions & { cockpit: CockpitFixture }>({
  sessionCount: [1, { option: true }],
  workspaceCount: [1, { option: true }],
  dormantSessionCount: [0, { option: true }],
  assets: ['packaged', { option: true }],
  assetPackageRoot: [null, { option: true }],
  backlogLimit: [512, { option: true }],
  gitWorkspace: [false, { option: true }],
  page: async ({ page, cockpit, assets }, use) => {
    if (assets === 'synced') {
      await page.addInitScript((expectedStyleCount) => {
        const root = document.documentElement;
        root.style.pointerEvents = 'none';
        const releaseWhenReady = (): boolean => {
          if (
            document.querySelectorAll('link[data-doompi-plugin-composition][media="all"]').length !== expectedStyleCount
          )
            return false;
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
      }, cockpit.pluginStyleCount);
    }
    for (const session of cockpit.sessions) {
      const waitForAttach = session.waitForAttach.bind(session);
      session.waitForAttach = async (timeoutMs = 5000): Promise<void> => {
        await waitForAttach(timeoutMs);
        if (assets === 'synced') {
          await page
            .locator('link[data-doompi-plugin-composition][media="all"]')
            .nth(cockpit.pluginStyleCount - 1)
            .waitFor({ state: 'attached', timeout: timeoutMs });
          await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
          );
        }
        await page.locator('[data-testid="composer-input"]:not([disabled])').waitFor({ timeout: timeoutMs });
      };
    }
    try {
      await use(page);
    } finally {
      await page.close();
    }
  },
  cockpit: async (
    { context, sessionCount, workspaceCount, dormantSessionCount, assets, assetPackageRoot, gitWorkspace },
    use,
  ) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-e2e-'));
    const syncedDist = process.env[SYNCED_DIST_ENV];
    if (assets === 'synced' && (syncedDist === undefined || syncedDist === ''))
      throw new Error('global setup did not publish the synchronized web bundle');

    const workflowHome = path.join(root, 'workflow-mcp');
    const agentDir = path.join(root, 'pi-agent');
    const runnerStore = path.join(agentDir, 'doom-runner');
    const processRegistryPath = path.join(root, 'process-registry');
    const teamTemp = path.join(root, 'tmp');
    const workRoot = path.join(root, 'workspaces');
    fs.mkdirSync(workRoot, { recursive: true });
    if (gitWorkspace) initializeGitWorkspace(root, workRoot);
    fs.mkdirSync(teamTemp, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousWorkflowHome = process.env.WORKFLOW_MCP_HOME;
    const previousProcessRegistryPath = process.env.PROCESS_REGISTRY_PATH;
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.WORKFLOW_MCP_HOME = workflowHome;
    process.env.PROCESS_REGISTRY_PATH = processRegistryPath;
    process.env.HOME = root;
    process.env.USERPROFILE = root;

    const assetsDir = assets === 'synced' ? syncedDist! : path.join(assetPackageRoot ?? packageRoot, 'dist', 'web');
    const syncedHome = process.env[SYNCED_HOME_ENV];
    if (syncedHome === undefined || syncedHome === '')
      throw new Error('global setup did not publish its isolated home');
    const workspaceRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
    const registration = readSyncRegistration(workspaceRoot, syncedHome);
    if (registration?.webDirectory === null || registration?.webDirectory === undefined)
      throw new Error('global setup did not publish a web registration');
    const workspaceId = registration.identity.worktreeId;
    const workspaces = Array.from({ length: workspaceCount }, (_, index) => ({
      id: index === 0 ? workspaceId : `${workspaceId}-${index + 1}`,
      root: index === 0 ? workRoot : path.join(root, `workspace-${index + 1}`),
    }));
    for (const workspace of workspaces) fs.mkdirSync(workspace.root, { recursive: true });
    const webCompositions = createWebCompositions(path.join(root, 'web-compositions'), (message) => {
      console.warn(`[cockpit fixture] ${message}`);
    });
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
    const sessionApis = new Map<string, PackageApiServer>();
    const hosts = new Map<string, HeadlessSessionHost>();
    let createSession = async (_request: DoomHubSessionCreateRequest): Promise<{ sessionId: string; cwd: string }> => {
      throw new Error('The Playwright headless fixture is not ready to create sessions.');
    };
    const dormantRecords: OpenSessionRecord[] = [];
    const dormantTranscriptEntries = new Map<string, TranscriptPage['entries']>();
    let readDormantTranscript = async (
      record: OpenSessionRecord,
      request: TranscriptPageRequest,
    ): Promise<TranscriptPage> => {
      void request;
      return {
        entries: dormantTranscriptEntries.get(record.sessionId) ?? [],
        startCursor: null,
        endCursor: null,
        olderCursor: null,
        newerCursor: null,
        generation: 0,
        revision: 0,
        context: [],
        drafts: [],
      };
    };
    let reviveSession = async (_record: OpenSessionRecord): Promise<void> => {
      throw new Error('The Playwright headless fixture is not ready to revive sessions.');
    };
    const manager = {
      async create(): Promise<HeadlessSessionHost> {
        throw new Error('The Playwright headless fixture does not create sessions through HTTP.');
      },
      get: (id: string) => hosts.get(id),
      sessions: () => [...hosts.values()],
      async closeSession(id: string): Promise<void> {
        await sessionApis.get(id)?.close();
        sessionApis.delete(id);
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
      createSession: (request) => createSession(request),
      admitWorkspace: async ({ name }) => ({ id: workspaceId, root: workRoot, ...(name ? { name } : {}) }),
      hubToken: () => E2E_HEADLESS_TOKEN,
      requestSessionApi: async (scope, request) => {
        const server = sessionApis.get(scope.sessionId);
        if (server === undefined) return Response.json({ error: 'Session API unavailable.' }, { status: 404 });
        const body = request.body === undefined || request.body === null ? undefined : request.body;
        return server.request(
          new Request(`http://session.local/api/plugins/${request.basePath}${request.path}`, {
            method: request.method,
            headers: request.headers,
            ...(body === undefined ? {} : { body }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }),
        );
      },
    });
    const source = resolveServerBundleSource({ registration });
    if (source.kind !== 'descriptor') throw new Error('global setup did not publish a synchronized server bundle');
    // The repository's minimal mode does not own Git. Use its real copilot
    // composition so browser tests exercise the backend, not only its UI bundle.
    const activeLayers = ['team', 'task', 'llm', 'source-control'];
    const [globalBundle, workspaceBundle, sessionBundle] = await Promise.all([
      loadServerBundle('global', { ...source, majorMode: 'copilot', activeLayers }),
      loadServerBundle('workspace', { ...source, majorMode: 'copilot', activeLayers }),
      loadServerBundle('session', { ...source, majorMode: 'copilot', activeLayers }),
    ]);
    const environment = Object.freeze({
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      PI_CODING_AGENT_DIR: agentDir,
      WORKFLOW_MCP_HOME: workflowHome,
      PROCESS_REGISTRY_PATH: processRegistryPath,
    });
    const repositories = () =>
      hub.workspaces().map((workspace) => ({
        id: workspace.id,
        path: workspace.root,
        name: path.basename(workspace.root),
        active: hub.snapshot().some((session) => session.workspaceId === workspace.id),
      }));
    await hub.mountFacets(globalBundle.facets, {
      scope: 'global',
      homeDirectory: root,
      environment,
      sessionService: hub.sessionService,
      directEvents: hub.directEvents,
      repositories,
      resolveRepository: (id) => hub.workspaces().find((workspace) => workspace.id === id)?.root,
      onNotice: (message) => console.error(`[global] ${message}`),
    });
    for (const workspace of workspaces)
      await hub.mountFacets(workspaceBundle.facets, {
        scope: 'workspace',
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        cwd: workspace.root,
        homeDirectory: root,
        environment,
        sessionService: hub.sessionService,
        directEvents: hub.directEvents,
        repositories,
        resolveRepository: (id) => workspaces.find((workspace) => workspace.id === id)?.root,
        onNotice: (message) => console.error(`[workspace] ${message}`),
      });
    const channels = hub.channelTypes();
    const globalComposition = webCompositions.publish({ scope: 'global' }, registration, channels);
    const workspaceCompositions = workspaces.map((workspace) => ({
      ...workspace,
      webComposition: webCompositions.publish(
        { scope: 'workspace', workspaceId: workspace.id },
        registration,
        channels,
      ),
    }));
    if (
      globalComposition === undefined ||
      workspaceCompositions.some((workspace) => workspace.webComposition === undefined)
    )
      throw new Error('global setup did not publish the E2E web compositions');
    let pluginStyleCount =
      globalComposition.stylePaths.length +
      workspaceCompositions.reduce((count, workspace) => count + (workspace.webComposition?.stylePaths.length ?? 0), 0);
    const sessionManifestUrls = new Map<string, string>();
    const manifestGates = new Map<string, { notify(): void; pending: Promise<void> }>();
    const holdSessionComposition = (sessionId: string): { requested: Promise<void>; release(): void } => {
      const manifestUrl = sessionManifestUrls.get(sessionId);
      if (manifestUrl === undefined) throw new Error(`Unknown fixture session '${sessionId}'.`);
      let notify!: () => void;
      let release!: () => void;
      const requested = new Promise<void>((resolve) => {
        notify = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      manifestGates.set(manifestUrl, { notify, pending });
      return {
        requested,
        release: () => {
          manifestGates.delete(manifestUrl);
          release();
        },
      };
    };
    const requestAsset = async (request: Request): Promise<Response | undefined> => {
      const gate = manifestGates.get(new URL(request.url).pathname);
      if (gate) {
        gate.notify();
        await gate.pending;
      }
      return await webCompositions.request(request);
    };

    let headless = await serveHeadlessServer({
      headlessHub: hub,
      port: 0,
      token: E2E_HEADLESS_TOKEN,
      requestAsset,
      dormantSessions: () => dormantRecords,
      readDormantTranscript: (record, request) => readDormantTranscript(record, request),
      reviveSession: (record) => reviveSession(record),
      onNotice: (message) => console.error(`[headless] ${message}`),
      compositions: () => ({
        global: globalComposition,
        publicKey: webCompositions.publicKey(),
        shell: webCompositions.shellTrust(),
        workspaces: workspaceCompositions,
      }),
    });
    const headlessUrl = (): string => headless.url;
    const restartHeadless = async (): Promise<void> => {
      const port = Number(new URL(headless.url).port);
      await headless.close();
      headless = await serveHeadlessServer({
        headlessHub: hub,
        port,
        token: E2E_HEADLESS_TOKEN,
        requestAsset,
        dormantSessions: () => dormantRecords,
        readDormantTranscript: (record, request) => readDormantTranscript(record, request),
        reviveSession: (record) => reviveSession(record),
        onNotice: (message) => console.error(`[headless] ${message}`),
        compositions: () => ({
          global: globalComposition,
          publicKey: webCompositions.publicKey(),
          shell: webCompositions.shellTrust(),
          workspaces: workspaceCompositions,
        }),
      });
    };

    const sessions: HeadlessSession[] = [];
    const registerFixtureSession = async (
      id: string,
      name: string,
      cwd: string,
      countPluginStyles: boolean,
      workspace = workspaces[0]!,
    ): Promise<HeadlessSession> => {
      fs.mkdirSync(cwd, { recursive: true });
      const webComposition = webCompositions.publish({ scope: 'session', sessionId: id }, registration, channels);
      if (webComposition === undefined) throw new Error(`global setup did not publish the '${id}' web composition`);
      sessionManifestUrls.set(id, webComposition.manifestUrl);
      if (countPluginStyles) pluginStyleCount += webComposition.stylePaths.length;
      const session = await startHeadlessSession({
        id,
        name,
        cwd,
        repoRoot: workspaceRoot,
        environment,
        workspaceId: workspace.id,
        webComposition,
        hub,
        headlessUrl,
        restartHeadless,
        onHost: (sessionId, host) => hosts.set(sessionId, host),
      });
      sessions.push(session);
      const host = hosts.get(id);
      if (host === undefined) throw new Error(`The '${id}' fixture host was not registered.`);
      sessionApis.set(
        id,
        await serveSessionApis({
          sessionId: id,
          workspaceId: workspace.id,
          workspaceRoot: workspace.root,
          homeDirectory: root,
          cwd: session.cwd,
          environment,
          directEvents: hub.directEvents,
          hubToken: E2E_HEADLESS_TOKEN,
          sessionService: hub.sessionService,
          publishActivity: (activity) => hub.setSessionActivity?.(id, activity),
          pluginRegistry: hub.pluginRegistry,
          apis: [],
          facets: sessionBundle.facets,
          mountChannel: (channel) => {
            const dispose = hub.registerChannel(channel, { scope: 'session', sessionId: id });
            return { mounted: true, dispose };
          },
          prepareFacets: host.prepareFacets,
          activateFacets: host.activateFacets,
          canDispatch: host.canDispatch,
          onNotice: (message) => console.error(`[session] ${message}`),
        }),
      );
      return session;
    };
    createSession = async (request) => {
      const sessionId = crypto.randomUUID();
      await registerFixtureSession(sessionId, request.name, request.cwd, false);
      return { sessionId, cwd: request.cwd };
    };
    // A revived record becomes an ordinary fixture session, which is what the
    // real server does: it reopens the journal the record names.
    reviveSession = async (record) => {
      const at = dormantRecords.findIndex((held) => held.sessionId === record.sessionId);
      if (at >= 0) dormantRecords.splice(at, 1);
      await registerFixtureSession(record.sessionId, record.name, record.cwd, false);
    };
    for (let index = 0; index < sessionCount; index += 1) {
      await registerFixtureSession(
        `s${index + 1}`,
        `session-${index + 1}`,
        path.join(workspaces[index % workspaces.length]!.root, `s${index + 1}`),
        index === 0,
        workspaces[index % workspaces.length],
      );
    }
    for (let index = 0; index < dormantSessionCount; index += 1) {
      const id = `d${index + 1}`;
      dormantTranscriptEntries.set(id, [
        {
          type: 'message',
          id: `${id}-user`,
          message: { role: 'user', content: `resume ${id} from the saved thread` },
        },
        {
          type: 'message',
          id: `${id}-assistant`,
          message: { role: 'assistant', content: `saved history for ${id}` },
        },
      ]);
      dormantRecords.push({
        sessionId: id,
        workspaceId,
        cwd: path.join(workRoot, id),
        name: `dormant-${index + 1}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
    }

    const web = await serveWeb({
      port: 0,
      assetsDir,
      headlessUrl: headless.url,
      headlessToken: E2E_HEADLESS_TOKEN,
    });

    try {
      await use({
        sessions,
        workspaces,
        holdSessionComposition,
        session: sessions[0]!,
        workflowHome,
        runnerStore,
        agentDir,
        teamTemp,
        publishSessionEvent: (type, sessionId, payload) => hub.directEvents.publish(type, sessionId, payload),
        publishPendingSetups: (sessionId, pending) => hub.setPendingSessionSetups?.(sessionId, pending),
        channels,
        pluginStyleCount,
        republishShell,
        url: web.url,
      });
    } finally {
      // Close pages opened through context.newPage() before stopping their HTTP server.
      for (const page of context.pages()) await page.close();
      await web.close();
      for (const server of sessionApis.values()) await server.close();
      await headless.close();
      for (const session of sessions) await session.close();
      webCompositions.close();
      fs.rmSync(root, { recursive: true, force: true });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousWorkflowHome === undefined) delete process.env.WORKFLOW_MCP_HOME;
      else process.env.WORKFLOW_MCP_HOME = previousWorkflowHome;
      if (previousProcessRegistryPath === undefined) delete process.env.PROCESS_REGISTRY_PATH;
      else process.env.PROCESS_REGISTRY_PATH = previousProcessRegistryPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  },
});

export { expect } from '@playwright/test';
