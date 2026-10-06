import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config/config';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import * as hubs from '@agimon-ai/doompi-core/headlessHub';
import * as servers from '@agimon-ai/doompi-core/headlessServer';
import * as mcp from '@agimon-ai/doompi-core/mcpFacet';
import * as moduleResolution from '@agimon-ai/doompi-core/moduleResolution';
import * as remotes from '@agimon-ai/doompi-core/remoteRuntime';
import * as harnessLogs from '@agimon-ai/doompi-core/runtimeLogSinkTelemetry';
import * as facets from '@agimon-ai/doompi-core/serverFacet';
import * as serverLogs from '@agimon-ai/doompi-core/serverTelemetry';
import * as registrations from '@agimon-ai/doompi-core/syncRegistration';
import type { SyncRegistration } from '@agimon-ai/doompi-core/syncRegistration';
import * as web from '@agimon-ai/doompi-core/webCompositions';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as bootstrap from '../../src/builders/cli/bootstrapLocator';
import * as contexts from '../../src/builders/cli/harnessContext';
import { syncHookModules } from '../../src/builders/hooks';
import * as computers from '../../src/builders/server/computerUseBinding';
import * as logSink from '../../src/builders/server/logSink';
import { runServerRuntime } from '../../src/builders/server/runtime';
import { createHarnessSession, loadHarnessState } from '../../src/composition/harnessState';
import * as states from '../../src/composition/syncState';

afterEach(() => vi.restoreAllMocks());

describe('hub hook generation admission', () => {
  it.each([true, false])(
    'synchronizes before constructing and pinning new sessions (no initial session: %s)',
    async (noSession) => {
      const { createHookModules } = await import(
        path.resolve(__dirname, '../../../../default/doompi-hook/src/exports/index.ts')
      );
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-hub-admission-')));
      const homeDirectory = path.join(root, 'home');
      const controller = new AbortController();
      fs.mkdirSync(path.join(root, '.doom'));
      fs.mkdirSync(homeDirectory);
      const globalRoot = globalDoomConfigDirectory(homeDirectory);
      fs.mkdirSync(globalRoot, { recursive: true });
      for (const directory of [path.join(root, '.doom'), globalRoot])
        fs.writeFileSync(
          path.join(directory, 'modes.yaml'),
          'defaultMajorMode: minimal\nlayers: {}\nmajorMode:\n  minimal: []\n',
        );
      const tokenFile = path.join(root, 'token');
      fs.writeFileSync(tokenFile, 'test-token');
      const current = new Map<string, SyncRegistration>();
      const fileStates = new Map<string, states.SyncState>();
      const config = loadMajorModesConfig(root, homeDirectory);
      let generation = 0;
      const syncWorkspace = vi.fn(async () => {
        const id = String(++generation);
        const directory = path.join(root, 'generations', id);
        const hookModules = await syncHookModules({ repoRoot: root, homeDirectory, config, directory });
        current.set(root, {
          root,
          generation: id,
          mcpBundle: { path: '/mcp.json', fingerprint: id, sha256: id },
        } as SyncRegistration);
        fileStates.set(id, { fileState: { hookModules } } as states.SyncState);
      });
      const telemetry = {
        runInSpan: async (_name: string, _attributes: unknown, operation: () => Promise<unknown>) => operation(),
        recordEvent: async () => undefined,
        flush: async () => undefined,
        shutdown: async () => undefined,
      };
      vi.spyOn(logSink, 'ensureGlobalLogSink').mockResolvedValue(undefined as never);
      vi.spyOn(computers, 'createComputerUseBinding').mockResolvedValue(undefined);
      vi.spyOn(serverLogs, 'createServerTelemetry').mockReturnValue(telemetry as never);
      vi.spyOn(harnessLogs, 'createHarnessTelemetry').mockReturnValue(telemetry as never);
      vi.spyOn(moduleResolution, 'optionalPackageEntry').mockReturnValue(
        path.resolve(__dirname, '../../../../default/doompi-hook/src/exports/index.ts'),
      );
      current.set(globalDoomConfigDirectory(homeDirectory), { generation: 'global' } as SyncRegistration);
      vi.spyOn(registrations, 'readSyncRegistration').mockImplementation((from) => current.get(from));
      vi.spyOn(states, 'readRegisteredSyncState').mockImplementation((record) => fileStates.get(record.generation)!);
      vi.spyOn(bootstrap, 'readRegisteredBootstrapStatus').mockReturnValue({
        fresh: true,
        bootstrap: '/bootstrap.mjs',
      });
      vi.spyOn(facets, 'resolveServerBundleSource').mockReturnValue({ kind: 'descriptor' } as never);
      vi.spyOn(facets, 'loadServerBundle').mockResolvedValue({ facets: [], descriptor: { entries: [] } } as never);
      vi.spyOn(mcp, 'loadMcpBundle').mockResolvedValue({ plugins: [] } as never);
      vi.spyOn(web, 'createWebCompositions').mockReturnValue({
        publishShell() {},
        publish() {},
        close: async () => undefined,
      } as never);
      vi.spyOn(remotes, 'createRemoteRuntime').mockReturnValue({ close: async () => undefined } as never);
      let contextId = 0;
      const buildContext = vi.spyOn(contexts, 'buildHarnessContext').mockImplementation(async (options) => {
        const environment = { ...options.environment };
        createHarnessSession(
          { ...loadHarnessState(environment).state, root },
          {
            directory: path.join(root, 'harness', String(++contextId)),
            environment,
          },
        );
        return {
          options,
          environment,
          resources: { temporaryDirectory: path.join(root, 'harness', String(contextId)) },
          hookGroups: undefined,
          selectedLayers: [],
          cleanup: async () => undefined,
        } as unknown as contexts.HarnessContext;
      });
      let hub: hubs.HeadlessHub | undefined;
      const originalHub = hubs.createHeadlessHub;
      const launch = vi.fn(async (options: Parameters<hubs.HeadlessHub['create']>[0]) => {
        const descriptor = loadHarnessState(options.environment).state.hookModules;
        if (fs.existsSync(path.join(root, 'start.mts'))) {
          const modules = createHookModules({ descriptor });
          try {
            const outcome = await modules.invoke(
              { hook: { module: path.join(root, 'start.mts') }, root },
              { type: 'session_start' } as never,
              {
                sessionId: options.sessionId,
                isSubagent: false,
                cwd: root,
                repoRoot: root,
                signal: controller.signal,
                sendMessage: async () => undefined,
                appendCustomEntry: async () => undefined,
              },
            );
            expect(outcome.failure).toBeUndefined();
          } finally {
            await modules.dispose();
          }
        }
        return {
          id: options.sessionId,
          cwd: options.cwd,
          workspaceId: options.workspaceId,
          name: options.sessionName,
          createdAt: new Date().toISOString(),
        } as never;
      });
      vi.spyOn(hubs, 'createHeadlessHub').mockImplementation((options) => {
        hub = originalHub(options);
        vi.spyOn(hub, 'create').mockImplementation(launch);
        return hub;
      });
      const listening = vi
        .spyOn(servers, 'serveHeadlessServer')
        .mockResolvedValue({ url: 'http://localhost', close: async () => undefined } as never);
      // The runtime and hub admission loop are real. Network, rendering and host creation are doubled.
      const running = runServerRuntime(
        { noSession, tokenFile, agentArgs: [], sessionName: 'initial', webPort: 0 },
        {
          cwd: root,
          environment: { HOME: homeDirectory, PI_CODING_AGENT_DIR: path.join(homeDirectory, '.pi', 'agent') },
          signal: controller.signal,
          notice: () => undefined,
          syncWorkspace,
          resolveHarnessOptions: ({ cwd, environment }) =>
            ({ repoRoot: root, cwd: cwd ?? root, environment, hooks: true, piArgs: [] }) as never,
        },
      );
      void running.catch(() => undefined);
      try {
        await vi.waitFor(() => expect(listening).toHaveBeenCalledOnce());
        await hub!.sessionService.create({ cwd: root, name: 'existing' });
        expect(syncWorkspace.mock.invocationCallOrder[0]).toBeLessThan(buildContext.mock.invocationCallOrder[0]);
        const existingDescriptor = loadHarnessState(launch.mock.calls[0][0].environment).state.hookModules;
        expect(hub!.workspaces()).toHaveLength(1);
        fs.writeFileSync(
          path.join(root, '.doom', 'hooks.yaml'),
          'groups:\n  core:\n    core: true\n    hooks:\n      - event: SessionStart\n        pi: {module: ./start.mts}\n',
        );
        fs.writeFileSync(
          path.join(root, 'start.mts'),
          `import fs from 'node:fs'; export default { setup() { return { session_start() { fs.writeFileSync(${JSON.stringify(path.join(root, 'started'))}, 'compiled'); } }; } };`,
        );
        syncWorkspace.mockClear();
        buildContext.mockClear();
        await hub!.sessionService.create({ cwd: root, name: 'new' });
        expect(syncWorkspace).toHaveBeenCalledOnce();
        expect(syncWorkspace.mock.invocationCallOrder[0]).toBeLessThan(buildContext.mock.invocationCallOrder[0]);
        expect(fs.readFileSync(path.join(root, 'started'), 'utf8')).toBe('compiled');
        expect(loadHarnessState(launch.mock.calls[0][0].environment).state.hookModules).toEqual(existingDescriptor);
        const admitted = launch.mock.calls.length;
        syncWorkspace.mockRejectedValueOnce(new Error('compilation failed'));
        await expect(hub!.sessionService.create({ cwd: root, name: 'failed' })).rejects.toThrow('compilation failed');
        expect(launch).toHaveBeenCalledTimes(admitted);
        syncWorkspace.mockResolvedValueOnce(undefined);
        fs.appendFileSync(
          path.join(root, '.doom', 'hooks.yaml'),
          '      - event: PreToolUse\n        pi: {module: ./not-compiled.mts}\n',
        );
        await expect(hub!.sessionService.create({ cwd: root, name: 'missing' })).rejects.toThrow('Run doompi sync');
        expect(launch).toHaveBeenCalledTimes(admitted);
      } finally {
        controller.abort();
        await running;
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
