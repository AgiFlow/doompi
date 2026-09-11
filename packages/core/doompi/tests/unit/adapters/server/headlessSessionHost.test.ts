import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { loadMajorModesConfig, resolveLayers, filterHookDisabledLayers } from '@agimon-ai/doompi-config/majorModes';
import { profileHeadlessFacet } from '@agimon-ai/doompi-profile/extensions/headless';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Models,
  type Model,
  type Api,
} from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { DOOM_HEADLESS_HOST_SERVICE, requireDoomHeadlessHost } from '@agimon-ai/doompi-extension-contracts/headless';
import type { LoadedServerFacet } from '@agimon-ai/doompi-extension-contracts/server-facet-loader';
import {
  createHeadlessSessionHost,
  restoreHeadlessSelection,
  validateDirectHeadlessArgs,
  isDirectHeadlessOptedIn,
} from '../../../../src/adapters/server/headlessSessionHost';
import { readContextDetail } from '../../../../src/adapters/contextDetailStore.ts';
import { serveSessionApis } from '../../../../src/adapters/server/packageApiServer';

const model: Model<Api> = {
  id: 'test',
  name: 'Test',
  api: 'test-api',
  provider: 'test-provider',
  baseUrl: 'http://localhost',
  reasoning: false,
  input: ['text'],
  contextWindow: 65_536,
  maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe('gated headless startup', () => {
  it('requires explicit opt-in and rejects unsupported or malformed arguments', () => {
    expect(isDirectHeadlessOptedIn({})).toBe(false);
    expect(isDirectHeadlessOptedIn({ DOOMPI_TEST_DIRECT_HEADLESS: '1' })).toBe(true);
    expect(() => validateDirectHeadlessArgs(['--mode', 'invalid'])).toThrow('does not support --mode');
    expect(() => validateDirectHeadlessArgs(['--name'])).toThrow('requires a value');
    expect(() => validateDirectHeadlessArgs(['--resume'])).toThrow('does not support --resume');
  });

  it('restores the latest valid control and minor-mode projections from history', () => {
    const fallback = { majorMode: 'copilot', activeLayers: ['tools'], domains: ['development'], minorModes: [] };
    const entries = [
      {
        type: 'custom',
        customType: 'doom-context',
        data: { selection: { majorMode: 'minimal', profile: 'caveman', domains: ['testing', 'engineering'] } },
      },
      {
        type: 'custom',
        customType: 'doom-minor-modes',
        data: {
          modes: [
            { id: 'goal', activation: 'active' },
            { id: 'voice-auto', activation: 'inactive' },
          ],
        },
      },
    ];

    expect(restoreHeadlessSelection(entries, fallback)).toEqual({
      majorMode: 'minimal',
      activeLayers: ['tools'],
      profile: 'caveman',
      domains: ['testing', 'engineering'],
      minorModes: ['goal'],
    });
  });
  it('installs retained facets into the real API host and changes actual provider tools in place', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-headless-startup-'));
    vi.stubEnv('PI_CODING_AGENT_DIR', path.join(root, 'agent'));
    fs.mkdirSync(path.join(root, '.doom'));
    fs.mkdirSync(path.join(root, 'agents', 'writer'), { recursive: true });
    fs.mkdirSync(path.join(root, 'agents', 'reviewer'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agents', 'writer', 'profile.md'), '# Writer');
    fs.writeFileSync(path.join(root, 'agents', 'reviewer', 'profile.md'), '# Reviewer');
    fs.writeFileSync(
      path.join(root, '.doom/profiles.yaml'),
      'profiles:\n  entries:\n    writer:\n      persona: agents/writer\n      env: {}\n    reviewer:\n      persona: agents/reviewer\n      env: {}\n',
    );
    fs.writeFileSync(
      path.join(root, '.doom/modes.yaml'),
      JSON.stringify({
        majorMode: {
          development: { description: 'Development', layers: ['tools'] },
          review: { description: 'Review', layers: [] },
        },
        layers: { tools: { packages: [] } },
      }),
    );
    const streamSimple = vi.fn<Models['streamSimple']>(() => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        api: model.api,
        model: model.id,
        provider: model.provider,
        timestamp: Date.now(),
        stopReason: 'stop',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    });
    vi.spyOn(ModelRuntime, 'create').mockResolvedValue({
      getModel: () => model,
      getModels: () => [model],
      getAvailable: async () => [model],
      streamSimple,
    } as unknown as ModelRuntime);
    vi.spyOn(SettingsManager, 'create').mockReturnValue(SettingsManager.inMemory());
    const installed = vi.fn();
    const shutdown = vi.fn();
    const started = vi.fn();
    const settled = vi.fn();
    const executeCommand = vi.fn(async (args: string) => {
      if (args === 'fail') throw new Error('Fixture command failure');
    });
    let resourceText = 'Fixture context';
    let resourceFailure = false;
    const facet: LoadedServerFacet = {
      retained: true,
      initiallyEligible: true,
      declaration: {
        packageName: '@test/tool',
        entry: './server.ts',
        module: './server.mjs',
        scopes: ['session'],
        required: true,
        owners: [
          { majorMode: 'development', layer: 'tools' },
          { majorMode: 'review', layer: 'tools' },
        ],
      },
      facet: {
        inject: [DOOM_HEADLESS_HOST_SERVICE],
        apply(context) {
          installed();
          const host = requireDoomHeadlessHost(context);
          host.registerTool({
            name: 'fixture_tool',
            description: 'Fixture tool',
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
          });
          host.registerHook({
            event: 'session_start',
            handle: () => {
              host.registerResource({ name: 'startup', kind: 'context', read: () => 'Startup context' });
            },
          });
          host.registerHook({ event: 'session_start', handle: started });
          host.registerCommand({ name: 'fixture', description: 'Fixture command', execute: executeCommand });
          host.registerHook({ event: 'session_shutdown', handle: shutdown });
          host.registerHook({
            event: 'agent_settled',
            async handle(_event, context) {
              await context.session.appendCustomEntry('fixture-settled', { completed: true });
              settled();
            },
          });
          host.registerActivity({
            name: 'fixture-status',
            start(context) {
              context.client.setStatus('fixture', 'Active');
              return () => context.client.setStatus('fixture', undefined);
            },
          });
          host.registerResource({
            name: 'context',
            kind: 'context',
            read: () => {
              if (resourceFailure) throw new Error('Fixture resource unavailable');
              return resourceText;
            },
          });
          host.registerResource({ name: 'fixture-skill', kind: 'skill', read: () => 'Skill body' });
          host.registerHook({
            event: 'before_agent_start',
            handle: (event) => ({ systemPrompt: `${String(event.systemPrompt)}\nFirst patch` }),
          });
          host.registerHook({
            event: 'before_agent_start',
            handle: (event) => ({ systemPrompt: `${String(event.systemPrompt)}\nSecond patch` }),
          });
        },
      },
    };
    const modeAction = vi.fn();
    const control: LoadedServerFacet = {
      retained: true,
      initiallyEligible: true,
      declaration: {
        ...facet.declaration,
        packageName: '@test/control',
        owners: ['development', 'review'].map((majorMode) => ({ majorMode, layer: 'default' })),
      },
      facet: {
        inject: [DOOM_HEADLESS_HOST_SERVICE],
        apply(context) {
          const host = requireDoomHeadlessHost(context);
          host.registerMinorMode({
            descriptor: {
              source: '@test/control',
              id: 'fixture-mode',
              label: 'Fixture mode',
              description: 'Fixture headless mode',
              order: 1,
              actions: [
                {
                  id: 'toggle',
                  label: 'Toggle',
                  description: 'Toggle mode',
                  contexts: ['headless'],
                  parameters: [],
                },
              ],
            },
            initialState: { activation: 'active', condition: 'ready', actions: [{ id: 'toggle', enabled: true }] },
            handleAction: modeAction,
          });
          host.registerCommand({
            name: 'mode',
            description: 'Change mode',
            execute: (args) => host.select({ majorMode: args.trim() }),
          });
        },
      },
    };
    const profile: LoadedServerFacet = {
      retained: true,
      initiallyEligible: true,
      declaration: {
        packageName: '@agimon-ai/doompi-profile',
        entry: './src/exports/extensions/headless.ts',
        module: './dist/extensions/headless.mjs',
        scopes: ['session'],
        required: true,
        owners: ['development', 'review'].map((majorMode) => ({ majorMode, layer: 'default' })),
      },
      facet: profileHeadlessFacet,
    };
    let session: Awaited<ReturnType<typeof createHeadlessSessionHost>> | undefined;
    let apis: Awaited<ReturnType<typeof serveSessionApis>> | undefined;
    try {
      session = await createHeadlessSessionHost({
        cwd: root,
        repoRoot: root,
        sessionId: 'startup-test',
        sessionName: 'Test',
        agentArgs: ['--session-dir', root],
        candidates: [facet.declaration, control.declaration, profile.declaration],
        resolveSelection: (requested) => {
          const config = loadMajorModesConfig(root, path.join(root, 'home'));
          return {
            ...requested,
            activeLayers: filterHookDisabledLayers(config, resolveLayers(config, requested.majorMode), false),
          };
        },
        selection: {
          majorMode: 'development',
          activeLayers: ['tools'],
          domains: [],
          minorModes: ['fixture-mode'],
          profile: 'writer',
        },
      });
      const frames: unknown[] = [];
      session.agent.onFrame((frame) => frames.push(frame));
      expect(session.canDispatch()).toBe(false);
      let requestId = 0;
      const request = (type: string, fields: Record<string, unknown> = {}) =>
        new Promise<Record<string, unknown>>((resolve) => {
          const id = `request-${++requestId}`;
          session!.agent.onFrame((frame) => {
            if (frame.type === 'response' && frame.id === id) resolve(frame);
          });
          session!.agent.send({ type, id, ...fields });
        });
      expect(await request('get_commands')).toMatchObject({ success: false });
      apis = await serveSessionApis({
        socketDir: root,
        sessionId: 'startup-test',
        cwd: root,
        internalToken: 'test-internal-token',
        hubToken: 'test-hub-token',
        apis: [],
        facets: [facet, control, profile],
        prepareFacets: session.prepareFacets,
        activateFacets: session.activateFacets,
        canDispatch: session.canDispatch,
        onNotice: vi.fn(),
      });
      expect(session.canDispatch()).toBe(true);
      expect(frames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'extension_ui_request',
            method: 'setStatus',
            statusKey: 'doom-major-mode',
            statusText: '*writer*:[development]',
          }),
          expect.objectContaining({
            type: 'extension_ui_request',
            method: 'setStatus',
            statusKey: 'doom-domain',
            statusText: '',
          }),
          expect.objectContaining({
            type: 'extension_ui_request',
            method: 'setStatus',
            statusKey: 'doom-profile',
            statusText: 'writer',
          }),
        ]),
      );
      const startupEntries = await session.runtime.lane.findEntries({ order: 'oldestFirst' }, BACKGROUND_CONTEXT);
      const startupContexts = startupEntries.filter(
        (entry) => entry.type === 'custom' && entry.customType === 'doom-context',
      );
      expect(startupContexts).toHaveLength(1);
      expect(startupContexts[0]).toMatchObject({ data: { revision: 1 } });
      expect(readContextDetail('startup-test')).toMatchObject({ revision: 1 });
      expect(startupEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'custom',
            customType: 'doom-context',
            data: expect.objectContaining({
              selection: { majorMode: 'development', profile: 'writer', domains: [] },
              groups: expect.arrayContaining([
                expect.objectContaining({
                  id: 'development',
                  kind: 'major',
                  items: expect.arrayContaining([expect.objectContaining({ name: 'fixture_tool', active: true })]),
                }),
                expect.objectContaining({
                  id: 'development',
                  items: expect.arrayContaining([
                    expect.objectContaining({
                      name: 'fixture-skill',
                      itemKind: 'skill',
                      active: true,
                      tokens: expect.any(Number),
                    }),
                  ]),
                }),
                expect.objectContaining({ id: 'fixture-mode', kind: 'minor' }),
              ]),
            }),
          }),
          expect.objectContaining({
            type: 'custom',
            customType: 'doom-minor-modes',
            data: expect.objectContaining({
              modes: expect.arrayContaining([expect.objectContaining({ id: 'fixture-mode', activation: 'active' })]),
            }),
          }),
        ]),
      );
      const harness = session.runtime.harness;
      expect(await request('get_commands')).toMatchObject({
        success: true,
        data: {
          commands: [
            { name: 'fixture', description: 'Fixture command', source: 'extension' },
            { name: 'mode', description: 'Change mode', source: 'extension' },
            {
              name: 'profile',
              description: 'Show or change the active DoomPi profile.',
              source: 'extension',
            },
            { name: 'minor', description: 'Toggle or drive minor modes', source: 'extension' },
          ],
        },
      });

      expect(await request('prompt', { message: '/minor fixture-mode toggle' })).toMatchObject({ success: true });
      expect(modeAction).toHaveBeenCalledOnce();

      expect(await request('prompt', { message: '/fixture hello world' })).toMatchObject({ success: true });
      expect(executeCommand).toHaveBeenLastCalledWith('hello world', expect.objectContaining({ repoRoot: root }));
      expect(await request('prompt', { message: '/fixture fail' })).toMatchObject({
        success: false,
        error: 'Fixture command failure',
      });
      expect(streamSimple).not.toHaveBeenCalled();
      await session.runtime.prompt('First');
      expect(settled).toHaveBeenCalledOnce();
      const entriesAfterPrompt = await session.runtime.lane.findEntries({ order: 'oldestFirst' }, BACKGROUND_CONTEXT);
      expect(
        entriesAfterPrompt.filter((entry) => entry.type === 'custom' && entry.customType === 'doom-context'),
      ).toHaveLength(1);
      expect(readContextDetail('startup-test')).toMatchObject({ revision: 1 });
      expect(streamSimple.mock.calls[0]?.[1].tools?.map((tool) => tool.name)).toEqual(['fixture_tool']);
      expect(started).toHaveBeenCalledTimes(1);
      expect(streamSimple.mock.calls[0]?.[1].systemPrompt).toBe(
        'Fixture context\n\n[PERSONA] You are operating as the person described below (source: agents/writer).\n\n# Writer\n\nStartup context\nFirst patch\nSecond patch',
      );
      expect(await request('prompt', { message: '/mode review' })).toMatchObject({ success: true });
      expect(session.host!.context.selection.activeLayers).toEqual([]);
      const reviewEntries = await session.runtime.lane.findEntries({ order: 'oldestFirst' }, BACKGROUND_CONTEXT);
      expect(
        reviewEntries.filter((entry) => entry.type === 'custom' && entry.customType === 'doom-context'),
      ).toHaveLength(2);
      expect(readContextDetail('startup-test')).toMatchObject({ revision: 2 });
      expect(await request('get_commands')).toMatchObject({
        success: true,
        data: {
          commands: [
            { name: 'mode', description: 'Change mode', source: 'extension' },
            {
              name: 'profile',
              description: 'Show or change the active DoomPi profile.',
              source: 'extension',
            },
            { name: 'minor', description: 'Toggle or drive minor modes', source: 'extension' },
          ],
        },
      });
      await expect(session.host!.dispatchCommand('fixture', 'stale')).rejects.toThrow('inactive or unknown');
      expect(executeCommand).toHaveBeenCalledTimes(2);
      await session.runtime.prompt('Disabled');
      expect(streamSimple.mock.calls[1]?.[1].tools ?? []).toEqual([]);
      expect(await request('prompt', { message: '/mode development' })).toMatchObject({ success: true });
      expect(session.host!.context.selection.activeLayers).toEqual(['tools']);
      expect(readContextDetail('startup-test')).toMatchObject({ revision: 3 });
      expect(await request('prompt', { message: '/fixture restored' })).toMatchObject({ success: true });
      expect(executeCommand).toHaveBeenCalledTimes(3);
      resourceText = 'Updated context';
      await session.runtime.prompt('Reenabled');
      expect(streamSimple.mock.calls[2]?.[1].systemPrompt).toBe(
        'Updated context\n\n[PERSONA] You are operating as the person described below (source: agents/writer).\n\n# Writer\n\nStartup context\nFirst patch\nSecond patch',
      );
      resourceFailure = true;
      await session.runtime.prompt('Resource failure').catch(() => undefined);
      expect(streamSimple).toHaveBeenCalledTimes(3);
      expect(session.canDispatch()).toBe(false);
      resourceFailure = false;
      await session.runtime.prompt('Resource recovered');
      expect(streamSimple).toHaveBeenCalledTimes(4);
      expect(session.canDispatch()).toBe(true);
      expect(session.runtime.harness).toBe(harness);
      expect(installed).toHaveBeenCalledOnce();

      const statusesBeforeFailure = frames.filter(
        (frame) =>
          typeof frame === 'object' && frame !== null && (frame as { type?: string }).type === 'extension_ui_request',
      ).length;
      const append = vi
        .spyOn(session.runtime, 'appendCustomEntry')
        .mockRejectedValueOnce(new Error('publication failed'));
      await expect(session.host!.select({ domains: ['failure'] })).rejects.toThrow('publication failed');
      expect(session.host!.status.ready).toBe(false);
      expect(
        frames.filter(
          (frame) =>
            typeof frame === 'object' && frame !== null && (frame as { type?: string }).type === 'extension_ui_request',
        ),
      ).toHaveLength(statusesBeforeFailure);
      expect(readContextDetail('startup-test')).toMatchObject({ revision: 3 });
      append.mockRestore();
      await session.host!.select({ domains: [] });
      expect(session.host!.status.ready).toBe(true);

      const pickerFrame = new Promise<Record<string, unknown>>((resolve) => {
        session!.agent.onFrame((frame) => {
          if (frame.type === 'extension_ui_request' && frame.method === 'select') resolve(frame);
        });
      });
      const profileRequest = request('prompt', { message: '/profile' });
      const picker = await pickerFrame;
      expect(picker).toMatchObject({
        title: 'Profile (current: writer)',
        options: ['reviewer', 'writer'],
      });
      expect(typeof picker.id).toBe('string');
      session.agent.send({ type: 'extension_ui_response', id: picker.id as string, value: 'reviewer' });
      await expect(profileRequest).resolves.toMatchObject({ success: true });
      expect(session.host!.context.selection.profile).toBe('reviewer');
      expect(frames).toContainEqual({ type: 'extension_ui_answered', id: picker.id });

      await session.dispose();
      expect(shutdown).toHaveBeenCalledOnce();
      expect(session.canDispatch()).toBe(false);
    } finally {
      await session?.dispose();
      await apis?.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
