import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadMajorModesConfig, resolveLayers, filterHookDisabledLayers } from '@agimon-ai/doompi-config/majorModes';
import { readContextDetail } from '@agimon-ai/doompi-core/context-detail-store';
import { DOOM_HEADLESS_HOST_SERVICE, requireDoomHeadlessHost } from '@agimon-ai/doompi-core/headless';
import {
  createHeadlessSessionHost,
  restoreHeadlessSelection as restoreCoreSelection,
  validateDirectHeadlessArgs,
} from '@agimon-ai/doompi-core/main';
import { serveSessionApis } from '@agimon-ai/doompi-core/package-api-server';
import type { LoadedServerFacet } from '@agimon-ai/doompi-core/server-facet';
import { readMinorModeCatalog } from '@agimon-ai/doompi-minor-mode';
import { serverMinorModes } from '@agimon-ai/doompi-minor-mode';
import minorModeServerFacet from '@agimon-ai/doompi-minor-mode/extensions/server';
import { restoreMinorModeSelection } from '@agimon-ai/doompi-minor-mode/projection';
import profileServerFacet from '@agimon-ai/doompi-profile/extensions/server';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Models,
  type Model,
  type Api,
} from '@earendil-works/pi-ai';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';

import { publishHeadlessSelectionStatus } from '../../../../src/builders/server/selectionStatus';

function restoreHeadlessSelection(
  entries: Parameters<typeof restoreCoreSelection>[0],
  fallback: Parameters<typeof restoreCoreSelection>[1],
) {
  const selection = restoreCoreSelection(entries, fallback);
  const values = restoreMinorModeSelection(entries);
  return values ? { ...selection, state: { ...selection.state, 'minor-mode': values } } : selection;
}

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
    const fallback = {
      majorMode: 'copilot',
      activeLayers: ['tools'],
      domains: ['development'],
      state: { 'minor-mode': [] },
    };
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
      state: { 'minor-mode': ['goal'] },
    });
  });

  it('falls back when persisted selections are malformed and filters minor modes safely', () => {
    const fallback = {
      majorMode: 'copilot',
      activeLayers: ['tools'],
      domains: ['development'],
      state: { 'minor-mode': ['fallback'] },
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
      state: { 'minor-mode': ['active'] },
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
    // The repository's own instructions. The server used to drop these entirely.
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Fixture repository instructions.');
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
    const resourceNotices = vi.fn();
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
          // No `path`, so it stays invocable but unadvertised: the prompt must not
          // point the model at a doom-headless:// URI it cannot open.
          host.registerResource({ name: 'fixture-skill', kind: 'skill', read: () => 'Skill body' });
          host.registerResource({
            name: 'fixture-documented-skill',
            kind: 'skill',
            description: 'Fixture skill the model can select',
            path: '/fixture/SKILL.md',
            read: () => 'Documented skill body',
          });
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
          context.plugin(
            serverMinorModes([
              {
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
              },
            ]),
          );
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
    const minor: LoadedServerFacet = {
      ...control,
      declaration: { ...control.declaration, packageName: '@agimon-ai/doompi-minor-mode' },
      facet: minorModeServerFacet,
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
        onNotice: resourceNotices,
        agentArgs: ['--session-dir', root],
        environment: admittedEnvironment,
        candidates: [minor.declaration, facet.declaration, control.declaration, profile.declaration],
        publishSelectionStatus: publishHeadlessSelectionStatus,
        contextGroups: (context) =>
          (readMinorModeCatalog(context)?.list() ?? [])
            .filter(({ state }) => state.activation === 'active')
            .map(({ descriptor }) => ({ id: descriptor.id, label: descriptor.label, kind: 'minor' })),
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
          state: { 'minor-mode': ['fixture-mode'] },
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
        facets: [minor, facet, control, profile],
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
      // The detail file behind the panel is keyed by the newest published
      // revision, and the composition republishes whenever the prompt a turn
      // built differs from the last one, so the checks below compare the two
      // rather than counting publishes the fixture happens to provoke.
      const contextEntries = async () =>
        (await session!.runtime.lane.findEntries({ order: 'oldestFirst' }, BACKGROUND_CONTEXT)).filter(
          (entry) => entry.type === 'custom' && entry.customType === 'doom-context',
        );
      const publishedRevision = async (): Promise<number> =>
        ((await contextEntries()).at(-1) as { data?: { revision?: number } } | undefined)?.data?.revision ?? 0;
      const startupEntries = await session.runtime.lane.findEntries({ order: 'oldestFirst' }, BACKGROUND_CONTEXT);
      const startupContexts = startupEntries.filter(
        (entry) => entry.type === 'custom' && entry.customType === 'doom-context',
      );
      expect(startupContexts).toHaveLength(1);
      expect(startupContexts[0]).toMatchObject({ data: { revision: 1 } });
      // Nothing has been sent, so the prompt on offer is the one before the
      // packages that hook a turn have added to it.
      expect(startupContexts[0]).toMatchObject({ data: { systemPrompt: { stage: 'base' } } });
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
        { name: 'minor', description: 'Toggle or drive minor modes' },
        { name: 'fixture', description: 'Fixture command' },
        { name: 'mode', description: 'Change mode' },
        { name: 'profile', description: 'Show or change the active DoomPi profile.' },
      ]);

      await session.runtime.prompt('/minor fixture-mode toggle');
      expect(modeAction).toHaveBeenCalledOnce();

      await session.runtime.prompt('/fixture hello world');
      expect(executeCommand).toHaveBeenLastCalledWith('hello world', expect.objectContaining({ repoRoot: root }));
      await expect(session.runtime.prompt('/fixture fail')).rejects.toThrow('Fixture command failure');
      expect(streamSimple).not.toHaveBeenCalled();
      await session.runtime.prompt('First');
      expect(settled).toHaveBeenCalledOnce();
      // The first turn builds a prompt the packages have patched, which is a
      // different answer to "what is this session running under" than the base
      // published at startup, so the composition republishes.
      const contextsAfterPrompt = await contextEntries();
      expect(contextsAfterPrompt).toHaveLength(2);
      expect(contextsAfterPrompt[1]).toMatchObject({ data: { systemPrompt: { stage: 'effective' } } });
      expect(readContextDetail('startup-test', admittedEnvironment)).toMatchObject({ revision: 2 });
      expect(streamSimple.mock.calls[0]?.[1].tools?.map((tool) => tool.name)).toEqual(['fixture_tool']);
      expect(started).toHaveBeenCalledTimes(1);
      const SKILLS_BLOCK =
        '<available_skills>\n' +
        '  <skill>\n' +
        '    <name>fixture-documented-skill</name>\n' +
        '    <description>Fixture skill the model can select</description>\n' +
        '    <location>/fixture/SKILL.md</location>\n' +
        '  </skill>\n' +
        '</available_skills>';
      const firstPrompt = streamSimple.mock.calls[0]?.[1].systemPrompt as string;
      // AGENTS.md now reaches a server session, in Pi's own framing, as it always has
      // in the terminal. Ungated, matching Pi: AGENTS.md is not a trust-gated resource.
      expect(firstPrompt).toContain('<project_context>');
      expect(firstPrompt).toContain('Project-specific instructions and guidelines:');
      expect(firstPrompt).toContain('Fixture repository instructions.');
      expect(firstPrompt).toContain('</project_instructions>');
      // Context resources stay unwrapped, so the persona still reads as instruction.
      expect(firstPrompt).toContain(
        'Fixture context\n\n[PERSONA] You are operating as the person described below (source: agents/writer).',
      );
      expect(firstPrompt).toContain('Startup context');
      // Pi puts the working directory last in the composed prompt; before_agent_start
      // patches land after it, so the hook chain's output trails the cwd line.
      expect(firstPrompt).toContain('Current working directory: ');
      expect(firstPrompt).toContain('First patch\nSecond patch');
      expect(firstPrompt.indexOf('Current working directory: ')).toBeLessThan(firstPrompt.indexOf('First patch'));
      // A path-bearing skill is advertised by name and location only; its body is not
      // in the prompt, and the pathless sibling is not advertised at all.
      expect(firstPrompt).toContain(SKILLS_BLOCK);
      expect(firstPrompt).not.toContain('Documented skill body');
      expect(firstPrompt).not.toContain('fixture-skill<');
      expect(firstPrompt).not.toContain('Skill body');
      await session.runtime.prompt('/mode review');
      expect(session.host!.context.selection.activeLayers).toEqual([]);
      expect(await contextEntries()).toHaveLength(3);
      expect(readContextDetail('startup-test', admittedEnvironment)).toMatchObject({ revision: 3 });
      expect(session.runtime.listCommands()).toEqual([
        { name: 'minor', description: 'Toggle or drive minor modes' },
        { name: 'mode', description: 'Change mode' },
        { name: 'profile', description: 'Show or change the active DoomPi profile.' },
      ]);
      await expect(session.host!.dispatchCommand('fixture', 'stale')).rejects.toThrow('inactive or unknown');
      expect(executeCommand).toHaveBeenCalledTimes(2);
      await session.runtime.prompt('Disabled');
      expect(streamSimple.mock.calls[1]?.[1].tools ?? []).toEqual([]);
      await session.runtime.prompt('/mode development');
      expect(session.host!.context.selection.activeLayers).toEqual(['tools']);
      expect(readContextDetail('startup-test', admittedEnvironment)).toMatchObject({
        revision: await publishedRevision(),
      });
      await session.runtime.prompt('/fixture restored');
      expect(executeCommand).toHaveBeenCalledTimes(3);
      resourceText = 'Updated context';
      await session.runtime.prompt('Reenabled');
      expect(streamSimple.mock.calls[2]?.[1].systemPrompt).toContain(
        'Updated context\n\n[PERSONA] You are operating as the person described below (source: agents/writer).',
      );
      resourceFailure = true;
      await session.runtime.prompt('Resource failure');
      // A resource that cannot be read is reported and skipped, not fatal. Before,
      // the throw reached the systemPrompt callback and denied every later request.
      expect(streamSimple).toHaveBeenCalledTimes(4);
      expect(session.canDispatch()).toBe(true);
      const failedPrompt = streamSimple.mock.calls[3]?.[1].systemPrompt as string;
      expect(failedPrompt).not.toContain('Updated context');
      expect(failedPrompt).toContain('Startup context');
      expect(resourceNotices).toHaveBeenCalledWith(expect.stringContaining('Could not read headless resource'));
      resourceFailure = false;
      await session.runtime.prompt('Resource recovered');
      expect(streamSimple).toHaveBeenCalledTimes(5);
      expect(session.canDispatch()).toBe(true);
      expect(session.runtime.harness).toBe(harness);
      expect(installed).toHaveBeenCalledOnce();

      const revisionBeforeFailure = await publishedRevision();
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
      expect(readContextDetail('startup-test', admittedEnvironment)).toMatchObject({
        revision: revisionBeforeFailure,
      });
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
