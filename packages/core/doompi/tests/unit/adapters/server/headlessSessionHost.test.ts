import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { loadMajorModesConfig, resolveLayers, filterHookDisabledLayers } from '@agimon-ai/doompi-config/majorModes';
import { profileServerFacet } from '@agimon-ai/doompi-profile/extensions/server';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Models,
  type Model,
  type Api,
} from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { DOOM_HEADLESS_HOST_SERVICE, requireDoomHeadlessHost } from '@agimon-ai/doompi-extension-contracts/headless';
import type { LoadedServerFacet } from '@agimon-ai/doompi-extension-contracts/server-facet';
import {
  createHeadlessSessionHost,
  restoreHeadlessSelection,
  validateDirectHeadlessArgs,
} from '../../../../src/controllers/headlessSessionHost';
import { readContextDetail } from '../../../../src/services/contextDetailStore';
import { serveSessionApis } from '../../../../src/controllers/packageApiServer';

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

describe('headless startup', () => {
  it('rejects unsupported or malformed arguments', () => {
    expect(() => validateDirectHeadlessArgs(['--mode', 'invalid'])).toThrow('does not support --mode');
    expect(() => validateDirectHeadlessArgs(['--name'])).toThrow('requires a value');
    expect(() => validateDirectHeadlessArgs(['--resume'])).toThrow('does not support --resume');
    for (const flag of [
      '--help',
      '--version',
      '--no-session',
      '--continue',
      '--offline',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--no-tools',
      '--no-builtin-tools',
      '--verbose',
    ]) {
      expect(() => validateDirectHeadlessArgs([flag])).toThrow(`does not support ${flag}`);
    }
    expect(() => validateDirectHeadlessArgs(['--tui-mode', 'regular'])).toThrow('does not support --tui-mode');
    expect(() => validateDirectHeadlessArgs(['--extensions', 'one'])).toThrow('does not support --extensions');
    expect(() => validateDirectHeadlessArgs(['--skills', 'testing'])).toThrow('does not support --skills');
    expect(() => validateDirectHeadlessArgs(['prompt'])).toThrow('positional prompts or files');
    expect(() => validateDirectHeadlessArgs(['--unknown-flag'])).toThrow('does not support --unknown-flag');
    expect(validateDirectHeadlessArgs([]).messages).toEqual([]);
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

  it('falls back when persisted selections are malformed and filters minor modes safely', () => {
    const fallback = {
      majorMode: 'copilot',
      activeLayers: ['tools'],
      domains: ['development'],
      minorModes: ['fallback'],
    };
    for (const selection of [
      null,
      {},
      { majorMode: 'minimal' },
      { majorMode: 'minimal', domains: 'testing' },
      { majorMode: 'minimal', domains: [], profile: 42 },
    ]) {
      expect(
        restoreHeadlessSelection([{ type: 'custom', customType: 'doom-context', data: { selection } }], fallback),
      ).toEqual(fallback);
    }

    expect(
      restoreHeadlessSelection(
        [
          { type: 'not-custom' },
          null as never,
          { type: 'custom', customType: 'doom-context', data: { selection: { majorMode: 'minimal', domains: [] } } },
          {
            type: 'custom',
            customType: 'doom-minor-modes',
            data: {
              modes: [
                null as never,
                { id: 'inactive', activation: 'inactive' },
                { id: 'active', activation: 'active' },
                { id: 42, activation: 'active' },
              ],
            },
          },
        ],
        fallback,
      ),
    ).toEqual({
      ...fallback,
      majorMode: 'minimal',
      domains: [],
      minorModes: ['active'],
    });
    expect(
      restoreHeadlessSelection(
        [{ type: 'custom', customType: 'doom-minor-modes', data: { modes: 'invalid' } }],
        fallback,
      ),
    ).toEqual(fallback);
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
            execute: (args) => host.changeSelection({ axis: 'majorMode', majorMode: args.trim() }),
          });
        },
      },
    };
    const profile: LoadedServerFacet = {
      retained: true,
      initiallyEligible: true,
      declaration: {
        packageName: '@agimon-ai/doompi-profile',
        entry: './src/extensions/server.ts',
        module: './dist/extensions/server.mjs',
        scopes: ['session'],
        required: true,
        owners: ['development', 'review'].map((majorMode) => ({ majorMode, layer: 'default' })),
      },
      facet: profileServerFacet,
    };
    const admittedEnvironment = { PI_CODING_AGENT_DIR: root };
    let session: Awaited<ReturnType<typeof createHeadlessSessionHost>> | undefined;
    let apis: Awaited<ReturnType<typeof serveSessionApis>> | undefined;
    try {
      session = await createHeadlessSessionHost({
        cwd: root,
        repoRoot: root,
        sessionId: 'startup-test',
        sessionName: 'Test',
        agentArgs: ['--session-dir', root],
        environment: admittedEnvironment,
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
      session.onPresentationFrame((frame) => frames.push(frame));
      expect(session.canDispatch()).toBe(false);
      expect(() => session!.runtime.listCommands()).toThrow('Headless capabilities are not installed');
      apis = await serveSessionApis({
        sessionId: 'startup-test',
        cwd: root,
        environment: admittedEnvironment,
        directEvents: {
          publish: () => undefined,
          subscribe: () => () => undefined,
          close: () => undefined,
        },
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
      expect(readContextDetail('startup-test', admittedEnvironment)).toMatchObject({ revision: 1 });
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
      expect(session.runtime.listCommands()).toEqual([
        { name: 'fixture', description: 'Fixture command' },
        { name: 'mode', description: 'Change mode' },
        { name: 'profile', description: 'Show or change the active DoomPi profile.' },
        { name: 'minor', description: 'Toggle or drive minor modes' },
      ]);

      await session.runtime.prompt('/minor fixture-mode toggle');
      expect(modeAction).toHaveBeenCalledOnce();

      await session.runtime.prompt('/fixture hello world');
      expect(executeCommand).toHaveBeenLastCalledWith('hello world', expect.objectContaining({ repoRoot: root }));
      await expect(session.runtime.prompt('/fixture fail')).rejects.toThrow('Fixture command failure');
      expect(streamSimple).not.toHaveBeenCalled();
      await session.runtime.prompt('First');
      expect(settled).toHaveBeenCalledOnce();
      const entriesAfterPrompt = await session.runtime.lane.findEntries({ order: 'oldestFirst' }, BACKGROUND_CONTEXT);
      expect(
        entriesAfterPrompt.filter((entry) => entry.type === 'custom' && entry.customType === 'doom-context'),
      ).toHaveLength(1);
      expect(readContextDetail('startup-test', admittedEnvironment)).toMatchObject({ revision: 1 });
      expect(streamSimple.mock.calls[0]?.[1].tools?.map((tool) => tool.name)).toEqual(['fixture_tool']);
      expect(started).toHaveBeenCalledTimes(1);
      expect(streamSimple.mock.calls[0]?.[1].systemPrompt).toBe(
        'Fixture context\n\n[PERSONA] You are operating as the person described below (source: agents/writer).\n\n# Writer\n\nStartup context\nFirst patch\nSecond patch',
      );
      await session.runtime.prompt('/mode review');
      expect(session.host!.context.selection.activeLayers).toEqual([]);
      const reviewEntries = await session.runtime.lane.findEntries({ order: 'oldestFirst' }, BACKGROUND_CONTEXT);
      expect(
        reviewEntries.filter((entry) => entry.type === 'custom' && entry.customType === 'doom-context'),
      ).toHaveLength(2);
      expect(readContextDetail('startup-test', admittedEnvironment)).toMatchObject({ revision: 2 });
      expect(session.runtime.listCommands()).toEqual([
        { name: 'mode', description: 'Change mode' },
        { name: 'profile', description: 'Show or change the active DoomPi profile.' },
        { name: 'minor', description: 'Toggle or drive minor modes' },
      ]);
      await expect(session.host!.dispatchCommand('fixture', 'stale')).rejects.toThrow('inactive or unknown');
      expect(executeCommand).toHaveBeenCalledTimes(2);
      await session.runtime.prompt('Disabled');
      expect(streamSimple.mock.calls[1]?.[1].tools ?? []).toEqual([]);
      await session.runtime.prompt('/mode development');
      expect(session.host!.context.selection.activeLayers).toEqual(['tools']);
      expect(readContextDetail('startup-test', admittedEnvironment)).toMatchObject({ revision: 3 });
      await session.runtime.prompt('/fixture restored');
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
      expect(readContextDetail('startup-test', admittedEnvironment)).toMatchObject({ revision: 3 });
      append.mockRestore();
      await session.host!.select({ domains: [] });
      expect(session.host!.status.ready).toBe(true);

      const pickerFrame = new Promise<Record<string, unknown>>((resolve) => {
        session!.onPresentationFrame((frame) => {
          if (frame.type === 'extension_ui_request' && frame.method === 'select') resolve(frame);
        });
      });
      const profileRequest = session.runtime.prompt('/profile');
      const picker = await pickerFrame;
      expect(picker).toMatchObject({
        title: 'Profile (current: writer)',
        options: ['reviewer', 'writer'],
      });
      expect(typeof picker.id).toBe('string');
      expect(
        session.respondToExtensionUi({ type: 'extension_ui_response', id: picker.id as string, value: 'reviewer' }),
      ).toBe(true);
      await profileRequest;
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
