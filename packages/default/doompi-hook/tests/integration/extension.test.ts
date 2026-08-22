import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HarnessState } from '@agimon-ai/doompi-config/types';
import {
  createDoomReadinessCoordinator,
  DOOM_READINESS_SERVICE,
} from '@agimon-ai/doompi-extension-contracts/readiness';
import { createDoomHelpService, DOOM_HELP_SERVICE } from '@agimon-ai/doompi-extension-contracts/help';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHookDocumentReader } from '../../src/adapters/hookDocuments.ts';
import { hookExtension } from '../../src/adapters/pi/extension.ts';
import type { HookDocumentReader, HookOutcome } from '../../src/types/hooks.ts';
import { type PiHarness, piHarness, SESSION_ID, stubRunner, TEST_CORDIS_ROOT } from '../helpers/piSession.ts';

const cordisHost = vi.hoisted(() => ({ resolveRoot: (_pi: unknown): unknown => undefined }));
const cordisRoots: Context[] = [];

vi.mock('@agimon-ai/doompi-extension-contracts/cordis-host', () => ({
  connectDoomCordisHost: async (pi: unknown) => ({
    root: cordisHost.resolveRoot(pi),
    runtime: { abiVersion: 1, generation: 'hook-test', hostId: 'hook-test', mode: 'composed' },
    dispose: async () => undefined,
  }),
}));

interface ToolCallResult {
  block: boolean;
  reason: string;
}

interface ToolResultChange {
  content: Array<{ text: string }>;
  isError: boolean;
}

let home = '';
let repoRoot = '';
let sessions: PiHarness[] = [];

function documentReader(): HookDocumentReader {
  return createHookDocumentReader({ homeDirectory: home, warn: () => undefined });
}

function writeRegistry(contents: string): string {
  const directory = path.join(repoRoot, '.doom');
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, 'hooks.yaml');
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function registry(event: string, command: string): string {
  return [
    'groups:',
    '  safety:',
    '    core: true',
    '    hooks:',
    `      - event: ${event}`,
    '        pi:',
    `          command: ${command}`,
  ].join('\n');
}

async function session(
  harness: Partial<HarnessState>,
  outcomes: Record<string, HookOutcome> = {},
  options: { hasUI?: boolean } = {},
): Promise<PiHarness & { calls: ReturnType<typeof stubRunner>['calls'] }> {
  const state = piHarness({ root: repoRoot, ...harness }, options);
  const { runner, calls } = stubRunner(outcomes);
  await hookExtension(state.pi, { runner, documents: documentReader() });
  sessions.push(state);
  return { ...state, calls };
}

function toolCall(toolCallId: string, toolName: string) {
  return { type: 'tool_call', toolCallId, toolName, input: { command: 'pwd' } };
}

function toolResult(toolCallId: string, toolName: string, isError = false) {
  return {
    type: 'tool_result',
    toolCallId,
    toolName,
    input: {},
    content: [{ type: 'text', text: 'tool output' }],
    isError,
  };
}

beforeEach(() => {
  cordisHost.resolveRoot = (pi) => {
    const provided = (pi as Record<PropertyKey, unknown>)[TEST_CORDIS_ROOT];
    const root = Context.is(provided) ? provided : new Context();
    if (!cordisRoots.includes(root)) cordisRoots.push(root);
    return root;
  };
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-hook-home-'));
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-hook-repo-'));
});

afterEach(async () => {
  for (const state of sessions) state.dispose();
  sessions = [];
  await Promise.allSettled(cordisRoots.splice(0).map((root) => root.fiber.dispose()));
  delete process.env.PI_SUBAGENT_CHILD;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('repository hook Pi lifecycle', () => {
  it('registers every lifecycle event this package observes', async () => {
    const state = await session({});

    expect([...state.handlers.keys()].sort()).toEqual([
      'agent_settled',
      'before_agent_start',
      'session_shutdown',
      'session_start',
      'tool_call',
      'tool_result',
    ]);
  });

  it('registers authoring Help independently of Config and follows provider replacement', async () => {
    const state = piHarness({ root: repoRoot }, { hasUI: false, provideConfig: false });
    const { runner } = stubRunner();
    await hookExtension(state.pi, { runner, documents: documentReader() });
    sessions.push(state);
    const first = createDoomHelpService('hook-help-first');
    const firstProvider = state.cordis.plugin((context) => context.provide(DOOM_HELP_SERVICE, first));
    await firstProvider;

    expect(first.listContributions()).toEqual([
      {
        source: '@agimon-ai/doompi-hook',
        moduleUrl: expect.stringMatching(/extension\.ts$/u),
        skills: [
          {
            name: 'doompi-author-hook',
            description:
              'Author DoomPi repository or plugin hooks. Use when creating or changing .doom/hooks.yaml, selecting hook groups from modes.yaml, writing hook commands, or adapting Claude Code hook payloads and decisions to DoomPi.',
          },
        ],
      },
    ]);

    await firstProvider.dispose();
    expect(first.listContributions()).toEqual([]);

    const replacement = createDoomHelpService('hook-help-replacement');
    const replacementProvider = state.cordis.plugin((context) => context.provide(DOOM_HELP_SERVICE, replacement));
    await replacementProvider;
    expect(replacement.listContributions()).toHaveLength(1);

    await state.handlers.get('session_shutdown')?.({}, state.ctx);
    expect(replacement.listContributions()).toEqual([]);
    await replacementProvider.dispose();
    first.dispose();
    replacement.dispose();
  });

  it('stays pending without Config and reloads exactly once per provider generation', async () => {
    writeRegistry(registry('PreToolUse', 'guard'));
    const state = piHarness({ root: repoRoot }, { provideConfig: false });
    const { runner, calls } = stubRunner();
    await hookExtension(state.pi, { runner, documents: documentReader() });
    sessions.push(state);

    await state.handlers.get('tool_call')?.(toolCall('call-pending', 'bash'), state.ctx);
    expect(calls).toEqual([]);

    await state.provideConfig({ root: repoRoot });
    await state.handlers.get('tool_call')?.(toolCall('call-first-provider', 'bash'), state.ctx);
    expect(calls).toHaveLength(1);

    await state.removeConfig();
    await state.handlers.get('tool_call')?.(toolCall('call-provider-removed', 'bash'), state.ctx);
    expect(calls).toHaveLength(1);

    await state.provideConfig({ root: repoRoot });
    await state.handlers.get('tool_call')?.(toolCall('call-reloaded-provider', 'bash'), state.ctx);
    expect(calls).toHaveLength(2);
  });

  it('uses the context session id and clears the visible pre-hook status', async () => {
    writeRegistry(registry('PreToolUse', 'guard'));
    const state = await session({});

    await state.handlers.get('tool_call')?.(toolCall('call-1', 'bash'), state.ctx);

    expect(state.calls[0]?.payload).toMatchObject({
      session_id: SESSION_ID,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: repoRoot,
    });
    expect(state.statuses[0]).toEqual(['repository-hooks:call-1:pre', 'Running pre-tool hooks for bash (1/1)...']);
    expect(state.statuses.at(-1)).toEqual(['repository-hooks:call-1:pre', undefined]);
  });

  it('sets no status at all in a session with no UI', async () => {
    writeRegistry(registry('PreToolUse', 'guard'));
    const state = await session({}, {}, { hasUI: false });

    await state.handlers.get('tool_call')?.(toolCall('call-headless', 'bash'), state.ctx);

    expect(state.calls).toHaveLength(1);
    expect(state.statuses).toEqual([]);
  });

  it('blocks a tool call a hook denied, and steers one it only wanted to redirect', async () => {
    writeRegistry(registry('PreToolUse', 'guard'));
    const denying = await session(
      {},
      {
        guard: { decision: { hookSpecificOutput: { permissionDecision: 'deny', reason: 'approval required' } } },
      },
    );
    const steering = await session(
      {},
      {
        guard: { decision: { hookSpecificOutput: { additionalContext: 'Use the safe path.' } } },
      },
    );

    const denied = await denying.handlers.get('tool_call')?.(toolCall('call-denied', 'write'), denying.ctx);
    const steered = await steering.handlers.get('tool_call')?.(toolCall('call-context', 'custom'), steering.ctx);

    expect(denied).toEqual({ block: true, reason: 'approval required' });
    expect(steered).toEqual({ block: true, reason: 'Use the safe path.' });
  });

  it('names the package when a hook blocks without saying why', async () => {
    writeRegistry(registry('PreToolUse', 'guard'));
    const state = await session({}, { guard: { decision: { decision: 'block' } } });

    const blocked = (await state.handlers.get('tool_call')?.(
      toolCall('call-silent', 'bash'),
      state.ctx,
    )) as ToolCallResult;

    expect(blocked.reason).toBe('Blocked by repository hook');
  });

  it('lets a tool call through when no hook had an opinion', async () => {
    writeRegistry(registry('PreToolUse', 'guard'));
    const state = await session({});

    expect(await state.handlers.get('tool_call')?.(toolCall('call-quiet', 'bash'), state.ctx)).toBeUndefined();
    expect(state.messages).toEqual([]);
  });

  it('steers after a pre-hook failure and appends a post-hook failure without changing the result', async () => {
    writeRegistry(registry('PreToolUse', 'guard'));
    const pre = await session(
      {},
      {
        guard: { failure: { command: 'guard', message: 'spawn unavailable', reason: 'spawn_failed' } },
      },
    );
    await pre.handlers.get('tool_call')?.(toolCall('call-2', 'bash'), pre.ctx);

    expect(pre.messages[0]?.customType).toBe('repository-hook-failure');
    expect(pre.messages[0]?.content).toMatch(/spawn unavailable[\s\S]*Options:/);

    writeRegistry(registry('PostToolUse', 'audit'));
    const post = await session(
      {},
      {
        audit: { failure: { command: 'audit', message: 'hook dependency missing', reason: 'non_zero_exit' } },
      },
    );
    const result = (await post.handlers.get('tool_result')?.(
      toolResult('call-3', 'write'),
      post.ctx,
    )) as ToolResultChange;

    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(2);
    expect(result.content.at(-1)?.text).toMatch(/hook dependency missing[\s\S]*Options:/);
  });

  it('preserves an existing tool error when a post-hook also denies the result', async () => {
    writeRegistry(registry('PostToolUse', 'audit'));
    const state = await session(
      {},
      {
        audit: { decision: { decision: 'block', reason: 'review the generated file' } },
      },
    );

    const result = (await state.handlers.get('tool_result')?.(
      toolResult('call-post-denied', 'edit', true),
      state.ctx,
    )) as ToolResultChange;

    expect(result.isError).toBe(true);
    expect(result.content.at(-1)?.text).toContain('review the generated file');
  });

  it('marks a successful result an error once a post-hook denies it', async () => {
    writeRegistry(registry('PostToolUse', 'audit'));
    const state = await session({}, { audit: { decision: { decision: 'block', reason: 'reverted' } } });

    const result = (await state.handlers.get('tool_result')?.(
      toolResult('call-post-block', 'write'),
      state.ctx,
    )) as ToolResultChange;

    expect(result.isError).toBe(true);
  });

  it('leaves a result untouched when every post-hook was silent', async () => {
    writeRegistry(registry('PostToolUse', 'audit'));
    const state = await session({});

    expect(await state.handlers.get('tool_result')?.(toolResult('call-quiet', 'write'), state.ctx)).toBeUndefined();
  });

  it('steers when the registry exists but cannot be parsed', async () => {
    const registryPath = writeRegistry('groups:\n  core:\n   - : :\n');
    const state = await session({});

    await state.handlers.get('tool_call')?.(toolCall('call-unreadable', 'read'), state.ctx);

    expect(state.messages[0]?.content).toContain(registryPath);
    expect(state.calls).toEqual([]);
  });

  it('treats a registry absent from both config locations as no hooks', async () => {
    const state = await session({});

    await state.handlers.get('tool_call')?.(toolCall('call-missing', 'read'), state.ctx);

    // Every .doom document layers global under repository, so a file in neither
    // location means "nothing configured" rather than a broken repository.
    expect(state.messages).toEqual([]);
    expect(state.calls).toEqual([]);
  });

  it('runs session lifecycle hooks with session-scoped status keys and forwards setup context', async () => {
    writeRegistry(registry('SessionStart', 'setup'));
    const state = await session(
      {},
      {
        setup: { decision: { hookSpecificOutput: { additionalContext: 'Repository setup is incomplete.' } } },
      },
    );

    await state.handlers.get('session_start')?.({}, state.ctx);
    await state.handlers.get('agent_settled')?.({}, state.ctx);
    await state.handlers.get('session_shutdown')?.({}, state.ctx);

    expect(state.statuses).toContainEqual([
      `repository-hooks:${SESSION_ID}:start`,
      'Running session-start hooks (1/1)...',
    ]);
    expect(state.statuses).toContainEqual([`repository-hooks:${SESSION_ID}:stop`, undefined]);
    expect(state.statuses).toContainEqual([`repository-hooks:${SESSION_ID}:end`, undefined]);
    expect(state.messages).toEqual([
      { customType: 'repository-hook-context', content: 'Repository setup is incomplete.', display: true },
    ]);
  });

  it('starts SessionStart hooks without blocking Pi and orders later hooks behind readiness', async () => {
    writeRegistry(
      [
        'groups:',
        '  safety:',
        '    hooks:',
        '      - event: SessionStart',
        '        pi:',
        '          command: setup',
        '      - event: PreToolUse',
        '        pi:',
        '          command: guard',
      ].join('\n'),
    );
    let finishSetup: (() => void) | undefined;
    const setupGate = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });
    const calls: string[] = [];
    const runner = {
      async run(hook: { command: string }) {
        calls.push(hook.command);
        if (hook.command === 'setup') await setupGate;
        return {};
      },
    };
    const state = piHarness({ root: repoRoot });
    sessions.push(state);
    const coordinator = createDoomReadinessCoordinator();
    await hookExtension(state.pi, { runner, documents: documentReader() });
    cordisRoots.at(-1)?.provide(DOOM_READINESS_SERVICE, coordinator);

    expect(state.handlers.get('session_start')?.({}, state.ctx)).toBeUndefined();
    await vi.waitFor(() => expect(calls).toEqual(['setup']));
    let promptStarted = false;
    const prompt = state.handlers
      .get('before_agent_start')?.({}, state.ctx)
      .then(() => {
        promptStarted = true;
      });
    const toolCallPromise = state.handlers.get('tool_call')?.(toolCall('call-ready', 'bash'), state.ctx);
    await Promise.resolve();
    expect(calls).toEqual(['setup']);
    expect(promptStarted).toBe(false);

    finishSetup?.();
    await Promise.all([prompt, toolCallPromise]);
    expect(promptStarted).toBe(true);
    expect(calls).toEqual(['setup', 'guard']);

    await coordinator.dispose();
    await state.handlers.get('session_shutdown')?.({}, state.ctx);
  });

  it('runs the stop binding on agent settled', async () => {
    writeRegistry(registry('Stop', 'close-step'));
    const state = await session({});

    await state.handlers.get('agent_settled')?.({}, state.ctx);

    expect(state.calls.map((call) => call.hook.command)).toEqual(['close-step']);
  });

  it('filters registry hooks by selected group, matcher, and subagent policy', async () => {
    process.env.PI_SUBAGENT_CHILD = '1';
    writeRegistry(
      [
        'groups:',
        '  selected:',
        '    hooks:',
        '      - event: PreToolUse',
        '        pi:',
        '          matcher: Bash',
        '          command: matching-hook',
        '      - event: PreToolUse',
        '        pi:',
        '          matcher: Write',
        '          command: wrong-tool-hook',
        '      - event: PreToolUse',
        '        pi:',
        '          command: child-skipped-hook',
        '          skipInSubagent: true',
        '  excluded:',
        '    hooks:',
        '      - event: PreToolUse',
        '        pi:',
        '          command: wrong-group-hook',
      ].join('\n'),
    );
    const state = await session({ hookGroups: ['selected'] });

    await state.handlers.get('tool_call')?.(toolCall('call-filtered', 'bash'), state.ctx);

    expect(state.calls.map((call) => call.hook.command)).toEqual(['matching-hook']);
  });

  it('runs matching plugin hooks and reports an unreadable plugin config', async () => {
    writeRegistry('groups: {}\n');
    const pluginRoot = path.join(repoRoot, 'plugin');
    const configPath = path.join(pluginRoot, 'hooks.json');
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'plugin-hook' }] }] } }),
    );
    const valid = await session({ pluginHooks: [{ pluginRoot, configPath }] });

    await valid.handlers.get('tool_call')?.(toolCall('call-plugin', 'bash'), valid.ctx);
    await valid.handlers.get('tool_call')?.(toolCall('call-plugin-skip', 'write'), valid.ctx);

    expect(valid.calls).toHaveLength(1);
    expect(valid.calls[0]?.options).toEqual({ repoRoot, pluginRoot });

    fs.writeFileSync(configPath, '{invalid');
    const invalid = await session({ pluginHooks: [{ pluginRoot, configPath }] });
    await invalid.handlers.get('tool_call')?.(toolCall('call-plugin-invalid', 'bash'), invalid.ctx);

    expect(invalid.messages[0]?.content).toContain(configPath);
  });

  it('runs plugin session-end hooks on shutdown and nothing from the registry', async () => {
    writeRegistry(registry('SessionEnd', 'registry-session-end'));
    const pluginRoot = path.join(repoRoot, 'plugin');
    const configPath = path.join(pluginRoot, 'hooks.json');
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ command: 'plugin-end' }] }] } }));
    const state = await session({ pluginHooks: [{ pluginRoot, configPath }] });

    await state.handlers.get('session_shutdown')?.({}, state.ctx);

    expect(state.calls.map((call) => call.hook.command)).toEqual(['plugin-end']);
    expect(state.calls[0]?.payload).toEqual({ session_id: SESSION_ID, cwd: repoRoot });
  });

  it('runs the session-end hooks once even if Pi fires shutdown twice', async () => {
    const pluginRoot = path.join(repoRoot, 'plugin');
    const configPath = path.join(pluginRoot, 'hooks.json');
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ command: 'plugin-end' }] }] } }));
    const state = await session({ pluginHooks: [{ pluginRoot, configPath }] });

    await state.handlers.get('session_shutdown')?.({}, state.ctx);
    await state.handlers.get('session_shutdown')?.({}, state.ctx);

    expect(state.calls).toHaveLength(1);
  });

  it('falls back to the session cwd when the harness recorded no root', async () => {
    writeRegistry(registry('PreToolUse', 'guard'));
    const state = piHarness({ root: undefined });
    // piHarness derives cwd from the harness root, so point it at the repository
    // the way a session launched outside the harness would see it.
    Object.assign(state.ctx, { cwd: repoRoot });
    const { runner, calls } = stubRunner();
    await hookExtension(state.pi, { runner, documents: documentReader() });
    sessions.push(state);

    await state.handlers.get('tool_call')?.(toolCall('call-no-root', 'bash'), state.ctx);

    expect(calls[0]?.options.repoRoot).toBe(repoRoot);
  });

  it('disposes the fiber when registration throws', async () => {
    const pi = {
      on: vi.fn(() => {
        throw new Error('registration boom');
      }),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    await expect(hookExtension(pi, { runner: stubRunner().runner, documents: documentReader() })).rejects.toThrow(
      'registration boom',
    );
  });
});

describe('bash hook end to end', () => {
  it('runs a real hook command, feeds it the payload, and reads the decision it printed', async () => {
    const script = path.join(repoRoot, 'hook.sh');
    const observedPayload = path.join(repoRoot, 'payload.json');
    const observedEnvironment = path.join(repoRoot, 'environment.txt');
    fs.writeFileSync(
      script,
      [
        '#!/bin/bash',
        `cat > "${observedPayload}"`,
        `echo "$CLAUDE_PROJECT_DIR" > "${observedEnvironment}"`,
        'echo \'{"decision":"block","reason":"real hook ran"}\'',
      ].join('\n'),
    );
    writeRegistry(registry('PreToolUse', `bash ${script}`));
    const state = piHarness({ root: repoRoot });
    sessions.push(state);
    await hookExtension(state.pi, { documents: documentReader() });
    const handler = state.handlers.get('tool_call') as (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

    const blocked = await handler(toolCall('call-real', 'bash'), state.ctx);

    expect(blocked).toEqual({ block: true, reason: 'real hook ran' });
    expect(JSON.parse(fs.readFileSync(observedPayload, 'utf8'))).toMatchObject({
      tool_name: 'Bash',
      hook_event_name: 'PreToolUse',
      cwd: repoRoot,
    });
    expect(fs.readFileSync(observedEnvironment, 'utf8').trim()).toBe(repoRoot);
  });
});
