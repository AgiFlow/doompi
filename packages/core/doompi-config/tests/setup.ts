import { Context } from '@deepseek-ai/cordis';
import { DoomConfigService } from '../src/providers/doomConfigService.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeDoomConfigTransition,
  createDoomConfigContext,
  createHarnessSession,
  DOOM_CONFIG_SERVICE,
  DOOM_VOICE_TTS_ENGINES,
  type DoomConfigPendingSelection,
  type DoomConfigSelection,
  disposeHarnessState,
  FILE_ONLY_STATE_FIELDS,
  getHarnessState,
  globalDoomConfigPath,
  HARNESS_STATE_KEYS,
  HARNESS_STATE_POINTER,
  harnessRoot,
  type IDoomConfigService,
  loadDoomConfig,
  loadHarnessState,
  mergeDoomConfigs,
  parseDoomConfig,
  projectHarnessEnvironment,
  provideDoomConfigContext,
  readHarnessState,
  repositoryDoomConfigPath,
  replaceDoomConfigContext,
  requireDoomConfigContext,
  requireHarnessPaths,
  requireHarnessRoot,
  resetHarnessStore,
  resolvePlanningPlansDirectory,
  resolveVoiceConfig,
  restoreHarnessStateSnapshot,
  snapshotHarnessState,
  updateHarnessState,
} from '../src/exports/index.ts';

const roots: string[] = [];
const ACTIVE_COMPOSITION_FINGERPRINT = 'a'.repeat(64);
const TARGET_COMPOSITION_FINGERPRINT = 'b'.repeat(64);

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}
afterEach(() => {
  vi.unstubAllEnvs();
  // The store caches for the life of a process, which a test suite is not.
  resetHarnessStore();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function configContext(
  repoRoot: string,
  selection?: DoomConfigSelection,
  pendingSelection?: DoomConfigPendingSelection,
) {
  const entries = [
    ...(selection
      ? [
          {
            type: 'custom',
            customType: 'doom-pi:config:v1',
            data: selection,
            id: 'entry-1',
            parentId: null,
            timestamp: new Date(0).toISOString(),
          },
        ]
      : []),
    ...(pendingSelection
      ? [
          {
            type: 'custom',
            customType: 'doom-pi:transition:v1',
            data: pendingSelection,
            id: 'entry-2',
            parentId: null,
            timestamp: new Date(1).toISOString(),
          },
        ]
      : []),
  ] as never[];
  return createDoomConfigContext({
    cwd: repoRoot,
    sessionManager: { getBranch: () => entries } as unknown as ExtensionContext['sessionManager'],
  });
}

describe('Doom configuration', () => {
  it('round-trips the complete harness process boundary', () => {
    const environment: NodeJS.ProcessEnv = {};
    const state = {
      root: '/repo',
      majorMode: 'dev',
      temporaryDirectory: '/tmp/doom',
      domains: ['development'],
      layers: ['guardrails'],
      profile: 'builder',
      profileEnvironment: { MODE: 'strict' },
      hookGroups: [] as string[],
      skillDirectories: ['/skills'],
      agentDirectories: ['/agents'],
      additionalDirectories: ['/shared'],
      childExtensions: ['/child.ts'],
      pluginDirectories: ['/plugin'],
      pluginHooks: [{ pluginRoot: '/plugin', configPath: '/plugin/hooks.json' }],
      mcpConfigPath: '/tmp/mcp.json',
      personaFile: '/tmp/persona.md',
      hooks: false,
      agents: false,
      mcp: true,
      allowProtectedWrites: false,
    };
    projectHarnessEnvironment(state, environment);

    // Everything except the documents only the file carries, which every
    // spawned process and every hook would otherwise copy in its environment.
    expect(readHarnessState(environment)).toEqual({ ...state, profileEnvironment: {}, pluginHooks: [] });
    expect(FILE_ONLY_STATE_FIELDS).toEqual(new Set(['profileEnvironment', 'pluginHooks', 'mcpProjection']));

    projectHarnessEnvironment({ personaFile: undefined, profile: undefined }, environment);
    expect(environment).not.toHaveProperty(HARNESS_STATE_KEYS.personaFile);
    expect(environment).not.toHaveProperty(HARNESS_STATE_KEYS.profile);
  });

  it('carries the fields the environment no longer publishes through the file', () => {
    const directory = temporaryRoot('doom-state-');
    const environment: NodeJS.ProcessEnv = {};
    const state = {
      ...readHarnessState({}),
      root: '/repo',
      profileEnvironment: { MODE: 'strict' },
      pluginHooks: [{ pluginRoot: '/plugin', configPath: '/plugin/hooks.json' }],
      mcpProjection: {
        version: 1 as const,
        enabled: false,
        fingerprint: 'disabled-test',
        repoRoot: '/repo',
        stagingDirectory: directory,
        sources: [],
      },
    };

    const filePath = createHarnessSession(state, { directory, environment });

    expect(environment[HARNESS_STATE_POINTER]).toBe(filePath);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    resetHarnessStore();
    expect(loadHarnessState(environment).state).toEqual(state);
  });

  it('restores an owned harness snapshot after a failed transition', () => {
    const directory = temporaryRoot('doom-state-transaction-');
    const environment: NodeJS.ProcessEnv = {};
    const initial = { ...readHarnessState({}), root: '/repo', majorMode: 'copilot', domains: ['engineering'] };
    createHarnessSession(initial, { directory, environment });
    resetHarnessStore();
    const snapshot = snapshotHarnessState(environment);

    updateHarnessState({ majorMode: 'minimal', domains: ['marketing'] }, environment);
    restoreHarnessStateSnapshot(snapshot, environment);

    expect(loadHarnessState(environment).state).toMatchObject({ majorMode: 'copilot', domains: ['engineering'] });
    expect(environment[HARNESS_STATE_KEYS.majorMode]).toBe('copilot');
    expect(environment[HARNESS_STATE_KEYS.domains]).toBe('engineering');
  });

  it('acknowledges a pending reload only when the booted harness matches its target', () => {
    const entries: Array<{ type: 'custom'; customType: string; data: unknown }> = [
      {
        type: 'custom',
        customType: 'doom-pi:transition:v1',
        data: {
          version: 1,
          operationId: 'reload-1',
          active: {
            version: 1,
            majorMode: 'copilot',
            domains: ['engineering'],
            compositionFingerprint: ACTIVE_COMPOSITION_FINGERPRINT,
          },
          target: {
            version: 1,
            majorMode: 'minimal',
            domains: ['engineering'],
            compositionFingerprint: TARGET_COMPOSITION_FINGERPRINT,
          },
          strategy: 'pi-reload',
          phase: 'pending',
        },
      },
    ];
    const context = {
      sessionManager: { getBranch: () => entries },
    } as unknown as ExtensionContext;
    const appended: unknown[] = [];
    const acknowledged = acknowledgeDoomConfigTransition(
      { appendEntry: (_type: string, data: unknown) => appended.push(data) },
      context,
      {
        ...readHarnessState({}),
        majorMode: 'minimal',
        domains: ['engineering'],
        compositionFingerprint: TARGET_COMPOSITION_FINGERPRINT,
      },
    );

    expect(acknowledged).toBe(true);
    expect(appended).toEqual([expect.objectContaining({ operationId: 'reload-1', phase: 'applied' })]);
  });

  it.each([
    ['missing', undefined],
    ['stale', ACTIVE_COMPOSITION_FINGERPRINT],
  ])('does not acknowledge a pending transition with a %s target fingerprint', (_name, targetFingerprint) => {
    const entries = [
      {
        type: 'custom',
        customType: 'doom-pi:transition:v1',
        data: {
          version: 1,
          operationId: 'reload-unverified',
          active: { version: 1, majorMode: 'copilot', domains: ['engineering'] },
          target: {
            version: 1,
            majorMode: 'minimal',
            domains: ['engineering'],
            compositionFingerprint: targetFingerprint,
          },
          strategy: 'pi-reload',
          phase: 'pending',
        },
      },
    ];
    const context = {
      sessionManager: { getBranch: () => entries },
    } as unknown as ExtensionContext;
    const appendEntry = vi.fn();

    expect(
      acknowledgeDoomConfigTransition({ appendEntry }, context, {
        ...readHarnessState({}),
        majorMode: 'minimal',
        domains: ['engineering'],
        compositionFingerprint: TARGET_COMPOSITION_FINGERPRINT,
      }),
    ).toBe(false);
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it('hands a spawned process a file it owns, without claiming it here', () => {
    const parentDirectory = temporaryRoot('doom-state-parent-');
    const childDirectory = temporaryRoot('doom-state-child-');
    const parentEnvironment: NodeJS.ProcessEnv = {};
    createHarnessSession(
      { ...readHarnessState({}), root: '/repo', majorMode: 'dev' },
      {
        directory: parentDirectory,
        environment: parentEnvironment,
      },
    );

    // What a spawner writes for a detached child: its own directory, and an
    // owner the child claims on its first read.
    const childEnvironment: NodeJS.ProcessEnv = {};
    const childPath = createHarnessSession(
      { ...readHarnessState({}), root: '/repo', majorMode: 'marketing' },
      {
        directory: childDirectory,
        environment: childEnvironment,
        unclaimed: true,
      },
    );

    expect(childEnvironment[HARNESS_STATE_POINTER]).toBe(childPath);
    expect(childEnvironment[HARNESS_STATE_POINTER]).not.toBe(parentEnvironment[HARNESS_STATE_POINTER]);

    // The child writes in place, because an unclaimed file is its own.
    resetHarnessStore();
    updateHarnessState({ domains: ['marketing'] }, childEnvironment);
    expect(childEnvironment[HARNESS_STATE_POINTER]).toBe(childPath);
    expect(JSON.parse(fs.readFileSync(childPath, 'utf8')).state.domains).toEqual(['marketing']);

    // And the parent's own state is untouched by any of it.
    resetHarnessStore();
    expect(loadHarnessState(parentEnvironment).state.majorMode).toBe('dev');
  });

  it('copies on write rather than rewriting a file another process owns', () => {
    const directory = temporaryRoot('doom-state-owner-');
    const filePath = path.join(directory, 'harness-state.json');
    const environment: NodeJS.ProcessEnv = { [HARNESS_STATE_POINTER]: filePath };
    write(
      filePath,
      JSON.stringify({
        version: 1,
        owner: { pid: process.pid + 1, startedAt: '2026-01-01T00:00:00.000Z' },
        state: { ...readHarnessState({}), root: '/parent' },
      }),
    );
    resetHarnessStore();

    updateHarnessState({ majorMode: 'dev' }, environment);

    expect(environment[HARNESS_STATE_POINTER]).not.toBe(filePath);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).state.majorMode).not.toBe('dev');
    disposeHarnessState(environment);
  });

  it('degrades malformed optional harness metadata without leaking state', () => {
    expect(
      readHarnessState({
        DOOMPI_PROFILE_ENV: '{bad',
        DOOMPI_CHILD_EXTENSIONS: '{bad',
        DOOMPI_PLUGIN_HOOKS: '{bad',
      }),
    ).toMatchObject({ profileEnvironment: {}, childExtensions: [], pluginHooks: [] });
    expect(readHarnessState({ DOOMPI_PROFILE_ENV: '[]' }).profileEnvironment).toEqual({});
    expect(readHarnessState({ DOOMPI_PROFILE_ENV: '{"OK":"yes","NO":1}' }).profileEnvironment).toEqual({
      OK: 'yes',
    });
    expect(readHarnessState({ DOOMPI_CHILD_EXTENSIONS: '{}' }).childExtensions).toEqual([]);
    expect(readHarnessState({ DOOMPI_PLUGIN_HOOKS: '{}' }).pluginHooks).toEqual([]);
    expect(
      readHarnessState({
        DOOMPI_PLUGIN_HOOKS: '[{"pluginRoot":"/valid","configPath":"/hooks"},{"bad":true}]',
      }).pluginHooks,
    ).toEqual([{ pluginRoot: '/valid', configPath: '/hooks' }]);
  });

  it('falls back to the environment for a process nobody wrote a file for', () => {
    vi.stubEnv(HARNESS_STATE_POINTER, '');
    vi.stubEnv(HARNESS_STATE_KEYS.root, '/repo');
    vi.stubEnv(HARNESS_STATE_KEYS.temporaryDirectory, '/tmp/doom');
    vi.stubEnv(HARNESS_STATE_KEYS.domains, 'development');

    expect(getHarnessState().domains).toEqual(['development']);
    expect(harnessRoot()).toBe('/repo');
    expect(requireHarnessPaths()).toEqual({ root: '/repo', temporaryDirectory: '/tmp/doom' });
  });

  it('reports a change through the store rather than through the environment', () => {
    const directory = temporaryRoot('doom-state-update-');
    const environment: NodeJS.ProcessEnv = {};
    createHarnessSession(
      { ...readHarnessState({}), root: '/repo', temporaryDirectory: directory },
      {
        directory,
        environment,
      },
    );

    // The state a reader sees changes with the store, not with a stray
    // assignment: the environment is output, and nothing reads it back.
    environment[HARNESS_STATE_KEYS.majorMode] = 'ignored';
    expect(updateHarnessState({ majorMode: 'marketing' }, environment).majorMode).toBe('marketing');
    expect(loadHarnessState(environment).state.majorMode).toBe('marketing');
    expect(environment[HARNESS_STATE_KEYS.majorMode]).toBe('marketing');

    disposeHarnessState(environment);
  });

  it('degrades to the process directory when no root is known', () => {
    expect(harnessRoot({ root: undefined })).toBe(process.cwd());
    expect(() => requireHarnessPaths({ root: undefined, temporaryDirectory: '/tmp' })).toThrow(HARNESS_STATE_KEYS.root);
  });

  it('asks only for the root when that is all the caller needs', () => {
    // The commands that read the repository never write to the run directory,
    // so a missing temporary directory must not stop them.
    expect(requireHarnessRoot({ root: '/repo' })).toBe('/repo');
    expect(() => requireHarnessRoot({ root: undefined })).toThrow(HARNESS_STATE_KEYS.root);
  });

  it('isolates branch selections in immutable Pi contexts', () => {
    const repo = temporaryRoot('doom-context-');
    vi.stubEnv(HARNESS_STATE_POINTER, '');
    vi.stubEnv('DOOMPI_ROOT', repo);
    vi.stubEnv('DOOMPI_MAJOR_MODE', 'copilot');
    vi.stubEnv('DOOMPI_DOMAINS', 'default');

    const selected = configContext(repo, {
      version: 1,
      majorMode: 'dev',
      domains: ['development'],
      profile: 'builder',
    });
    const freshSession = configContext(repo);

    expect(selected.harness).toMatchObject({ majorMode: 'copilot', domains: ['default'] });
    expect(selected.pendingSelection).toMatchObject({
      active: { majorMode: 'copilot', domains: ['default'] },
      target: { majorMode: 'dev', domains: ['development'], profile: 'builder' },
      strategy: 'process-relaunch',
      phase: 'pending',
    });
    expect(selected.requiresRelaunch).toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected.harness.domains)).toBe(true);
    expect(freshSession.harness).toMatchObject({ majorMode: 'copilot', domains: ['default'] });
    expect(freshSession.harness.profile).toBeUndefined();
    expect(freshSession.requiresRelaunch).toBe(false);
  });
  it('treats a matching legacy selection as active', () => {
    const repo = temporaryRoot('doom-context-matching-');
    vi.stubEnv(HARNESS_STATE_POINTER, '');
    vi.stubEnv('DOOMPI_ROOT', repo);
    vi.stubEnv('DOOMPI_MAJOR_MODE', 'copilot');
    vi.stubEnv('DOOMPI_DOMAINS', 'default');

    const context = configContext(repo, { version: 1, majorMode: 'copilot', domains: ['default'] });

    expect(context.harness.majorMode).toBe('copilot');
    expect(context.pendingSelection).toBeUndefined();
    expect(context.requiresRelaunch).toBe(false);
  });

  it('retains a matching pending transition until a fresh session explicitly acknowledges it', () => {
    const repo = temporaryRoot('doom-context-pending-matched-');
    vi.stubEnv(HARNESS_STATE_POINTER, '');
    vi.stubEnv('DOOMPI_ROOT', repo);
    vi.stubEnv('DOOMPI_MAJOR_MODE', 'copilot');
    vi.stubEnv('DOOMPI_DOMAINS', 'default');
    vi.stubEnv('DOOMPI_COMPOSITION_FINGERPRINT', TARGET_COMPOSITION_FINGERPRINT);
    const pendingSelection: DoomConfigPendingSelection = {
      version: 1,
      operationId: 'operation-matched',
      active: {
        version: 1,
        majorMode: 'dev',
        domains: ['development'],
        compositionFingerprint: ACTIVE_COMPOSITION_FINGERPRINT,
      },
      target: {
        version: 1,
        majorMode: 'copilot',
        domains: ['default'],
        compositionFingerprint: TARGET_COMPOSITION_FINGERPRINT,
      },
      strategy: 'process-relaunch',
      phase: 'pending',
    };

    const context = configContext(repo, undefined, pendingSelection);

    expect(context.harness.majorMode).toBe('copilot');
    expect(context.pendingSelection).toEqual(pendingSelection);
    expect(context.requiresRelaunch).toBe(false);
  });

  it('uses the latest versioned pending transition without changing the active harness', () => {
    const repo = temporaryRoot('doom-context-pending-');
    vi.stubEnv(HARNESS_STATE_POINTER, '');
    vi.stubEnv('DOOMPI_ROOT', repo);
    vi.stubEnv('DOOMPI_MAJOR_MODE', 'copilot');
    vi.stubEnv('DOOMPI_DOMAINS', 'default');
    vi.stubEnv('DOOMPI_COMPOSITION_FINGERPRINT', ACTIVE_COMPOSITION_FINGERPRINT);
    const pendingSelection: DoomConfigPendingSelection = {
      version: 1,
      operationId: 'operation-1',
      active: {
        version: 1,
        majorMode: 'copilot',
        domains: ['default'],
        compositionFingerprint: ACTIVE_COMPOSITION_FINGERPRINT,
      },
      target: {
        version: 1,
        majorMode: 'dev',
        domains: ['development'],
        compositionFingerprint: TARGET_COMPOSITION_FINGERPRINT,
      },
      strategy: 'process-relaunch',
      phase: 'pending',
    };

    const context = configContext(repo, undefined, pendingSelection);

    expect(context.harness.majorMode).toBe('copilot');
    expect(context.pendingSelection).toEqual(pendingSelection);
    expect(context.requiresRelaunch).toBe(true);
  });

  it('publishes config through owned Cordis fibers and replaces snapshots atomically', async () => {
    const repo = temporaryRoot('doom-context-binding-');
    vi.stubEnv('DOOMPI_ROOT', repo);
    const contextA = new Context();
    const contextB = new Context();
    const firstA = configContext(repo, { version: 1, majorMode: 'dev', domains: ['development'] });
    const nextA = configContext(repo, { version: 1, majorMode: 'minimal', domains: ['qa'] });
    const valueB = configContext(repo, { version: 1, majorMode: 'marketing', domains: ['marketing'] });

    const fiberA = contextA.plugin((ctx) => {
      provideDoomConfigContext(ctx, firstA, 'config-a');
    });
    const fiberB = contextB.plugin((ctx) => {
      provideDoomConfigContext(ctx, valueB, 'config-b');
    });
    await Promise.all([fiberA.await(), fiberB.await()]);

    replaceDoomConfigContext(contextA, nextA);
    expect(requireDoomConfigContext(contextA)).toBe(nextA);
    expect(requireDoomConfigContext(contextB)).toBe(valueB);

    await fiberA.dispose();
    expect(() => requireDoomConfigContext(contextA)).toThrow('unavailable');
    expect(requireDoomConfigContext(contextB)).toBe(valueB);
    await fiberB.dispose();
  });
  it('strictly parses voice adapters and resolves defaults', () => {
    const parsed = parseDoomConfig(
      `voice:\n  engine: whisper-cpp\n  recorder:\n    device: none:2\n  adapters:\n    whisper-cpp:\n      binary: /bin/whisper-cli\n      model:\n        path: /models/base.bin\n`,
      '/config.yaml',
    );
    expect(parsed.voice).toMatchObject({
      engine: 'whisper-cpp',
      recorder: { device: 'none:2' },
      adapters: { 'whisper-cpp': { binary: '/bin/whisper-cli', model: { path: '/models/base.bin' } } },
    });
    expect(resolveVoiceConfig(parsed.voice!)).toMatchObject({ language: 'auto', recorder: { device: 'none:2' } });
  });
  it('parses and resolves global autonomous voice settings', () => {
    const parsed = parseDoomConfig(
      `voice:
  autoCapture:
    model: openai/gpt-4.1-mini
    startPhrases:
      - Hey Doom
      - begin now
    stopPhrases:
      - stop speaking
    utteranceIdleMs: 4500
    transcriptionTimeoutMs: 20000
    tts:
      engine: macos-say
      voice: Samantha
      rate: 190
`,
      '/global.yaml',
    );

    expect(DOOM_VOICE_TTS_ENGINES).toEqual(['macos-say']);
    expect(parsed.voice?.autoCapture).toEqual({
      model: 'openai/gpt-4.1-mini',
      startPhrases: ['Hey Doom', 'begin now'],
      stopPhrases: ['stop speaking'],
      utteranceIdleMs: 4500,
      transcriptionTimeoutMs: 20000,
      tts: { engine: 'macos-say', voice: 'Samantha', rate: 190 },
    });
    expect(resolveVoiceConfig(parsed.voice!)).toMatchObject({
      autoCapture: {
        model: 'openai/gpt-4.1-mini',
        startPhrases: ['Hey Doom', 'begin now'],
        stopPhrases: ['stop speaking'],
        utteranceIdleMs: 4500,
        transcriptionTimeoutMs: 20000,
        tts: { engine: 'macos-say', voice: 'Samantha', rate: 190 },
      },
    });

    const withoutPhrases = parseDoomConfig(
      'voice:\n  autoCapture:\n    model: anthropic/claude-sonnet-4-5\n    tts:\n      engine: macos-say\n',
      '/global.yaml',
    );
    expect(resolveVoiceConfig(withoutPhrases.voice!).autoCapture).toMatchObject({
      startPhrases: [],
      stopPhrases: [],
      utteranceIdleMs: 3000,
      transcriptionTimeoutMs: 15_000,
    });
  });
  it.each([1500, 3000, 10_000])('accepts autonomous utterance idle bound %i', (utteranceIdleMs) => {
    const parsed = parseDoomConfig(
      `voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    utteranceIdleMs: ${utteranceIdleMs}\n    tts:\n      engine: macos-say\n`,
      '/config.yaml',
    );
    expect(resolveVoiceConfig(parsed.voice!).autoCapture?.utteranceIdleMs).toBe(utteranceIdleMs);
  });
  it.each([
    ['string', '"3000"'],
    ['fraction', '3000.5'],
    ['below range', '1499'],
    ['above range', '10001'],
  ])('rejects autonomous utterance idle %s', (_name, value) => {
    expect(() =>
      parseDoomConfig(
        `voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    utteranceIdleMs: ${value}\n    tts:\n      engine: macos-say\n`,
        '/config.yaml',
      ),
    ).toThrow('voice.autoCapture.utteranceIdleMs');
  });
  it('defaults the composition phrases to a usable set', () => {
    const parsed = parseDoomConfig(
      'voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    tts:\n      engine: macos-say\n',
      '/global.yaml',
    );
    // Unlike start and stop phrases these cannot default to empty: with no send phrase a
    // draft could be opened and never submitted.
    expect(resolveVoiceConfig(parsed.voice!).autoCapture).toMatchObject({
      composeOpenPhrases: ['hey doom', 'doom prompt'],
      composeSendPhrases: ["that's it", 'doom send'],
      composeCancelPhrases: ['doom cancel', 'scratch that'],
      composeUtteranceIdleMs: 1200,
      composeNudgeMs: 10_000,
    });
  });
  it('parses explicit composition phrases and timings', () => {
    const parsed = parseDoomConfig(
      `voice:
  autoCapture:
    model: openai/gpt-4.1
    composeOpenPhrases:
      - start dictation
    composeSendPhrases:
      - all done
    composeCancelPhrases:
      - forget it
    composeUtteranceIdleMs: 900
    composeNudgeMs: 0
    tts:
      engine: macos-say
`,
      '/global.yaml',
    );
    expect(resolveVoiceConfig(parsed.voice!).autoCapture).toMatchObject({
      composeOpenPhrases: ['start dictation'],
      composeSendPhrases: ['all done'],
      composeCancelPhrases: ['forget it'],
      composeUtteranceIdleMs: 900,
      composeNudgeMs: 0,
    });
  });
  it('allows a compose-open phrase to double as a start phrase', () => {
    // Addressing the agent and opening a draft are the same gesture, and the shipped
    // defaults deliberately share `hey doom`. Forbidding the overlap would make the
    // default configuration illegal.
    const parsed = parseDoomConfig(
      'voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    startPhrases: ["hey doom"]\n    composeOpenPhrases: ["Hey, Doom!"]\n    tts:\n      engine: macos-say\n',
      '/global.yaml',
    );
    expect(resolveVoiceConfig(parsed.voice!).autoCapture).toMatchObject({
      startPhrases: ['hey doom'],
      composeOpenPhrases: ['Hey, Doom!'],
    });
  });
  it.each([
    ['send and cancel', 'composeSendPhrases: ["all done"]\n    composeCancelPhrases: ["All, Done!"]'],
    ['open and send', 'composeOpenPhrases: ["all done"]\n    composeSendPhrases: ["all done"]'],
    ['open and cancel', 'composeOpenPhrases: ["all done"]\n    composeCancelPhrases: ["all done"]'],
    ['stop and send', 'stopPhrases: ["all done"]\n    composeSendPhrases: ["all done"]'],
    ['stop and cancel', 'stopPhrases: ["all done"]\n    composeCancelPhrases: ["all done"]'],
  ])('rejects a phrase claimed by both %s', (_name, body) => {
    expect(() =>
      parseDoomConfig(
        `voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    ${body}\n    tts:\n      engine: macos-say\n`,
        '/config.yaml',
      ),
    ).toThrow('does not allow a phrase in both');
  });
  it.each([800, 1200, 3000])('accepts composition idle bound %i', (composeUtteranceIdleMs) => {
    const parsed = parseDoomConfig(
      `voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    composeUtteranceIdleMs: ${composeUtteranceIdleMs}\n    tts:\n      engine: macos-say\n`,
      '/config.yaml',
    );
    expect(resolveVoiceConfig(parsed.voice!).autoCapture?.composeUtteranceIdleMs).toBe(composeUtteranceIdleMs);
  });
  it.each([
    ['below range', '799'],
    ['above range', '3001'],
    ['fraction', '1200.5'],
  ])('rejects composition idle %s', (_name, value) => {
    expect(() =>
      parseDoomConfig(
        `voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    composeUtteranceIdleMs: ${value}\n    tts:\n      engine: macos-say\n`,
        '/config.yaml',
      ),
    ).toThrow('voice.autoCapture.composeUtteranceIdleMs');
  });
  it.each([
    ['below range but not the off switch', '4999'],
    ['above range', '60001'],
    ['string', '"10000"'],
  ])('rejects composition nudge %s', (_name, value) => {
    expect(() =>
      parseDoomConfig(
        `voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    composeNudgeMs: ${value}\n    tts:\n      engine: macos-say\n`,
        '/config.yaml',
      ),
    ).toThrow('voice.autoCapture.composeNudgeMs');
  });
  it.each([1000, 15_000, 120_000])('accepts autonomous transcription timeout bound %i', (timeoutMs) => {
    const parsed = parseDoomConfig(
      `voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    transcriptionTimeoutMs: ${timeoutMs}\n    tts:\n      engine: macos-say\n`,
      '/config.yaml',
    );
    expect(resolveVoiceConfig(parsed.voice!).autoCapture?.transcriptionTimeoutMs).toBe(timeoutMs);
  });
  it.each([
    ['string', '"15000"'],
    ['fraction', '15000.5'],
    ['below range', '999'],
    ['above range', '120001'],
  ])('rejects autonomous transcription timeout %s', (_name, value) => {
    expect(() =>
      parseDoomConfig(
        `voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    transcriptionTimeoutMs: ${value}\n    tts:\n      engine: macos-say\n`,
        '/config.yaml',
      ),
    ).toThrow('voice.autoCapture.transcriptionTimeoutMs');
  });
  it.each([
    [
      'missing provider',
      'voice:\n  autoCapture:\n    model: gpt-4.1\n    tts:\n      engine: macos-say\n',
      'provider/model-id',
    ],
    [
      'missing model',
      'voice:\n  autoCapture:\n    model: openai/\n    tts:\n      engine: macos-say\n',
      'provider/model-id',
    ],
    [
      'model whitespace',
      'voice:\n  autoCapture:\n    model: openai/gpt 4.1\n    tts:\n      engine: macos-say\n',
      'provider/model-id',
    ],
    [
      'unknown autonomous field',
      'voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    typo: true\n    tts:\n      engine: macos-say\n',
      'unsupported voice.autoCapture field(s): typo',
    ],
    ['missing tts', 'voice:\n  autoCapture:\n    model: openai/gpt-4.1\n', 'voice.autoCapture.tts'],
    [
      'invalid tts engine',
      'voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    tts:\n      engine: cloud\n',
      'voice.autoCapture.tts.engine',
    ],
    [
      'unknown tts field',
      'voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    tts:\n      engine: macos-say\n      binary: /tmp/say\n',
      'unsupported voice.autoCapture.tts field(s): binary',
    ],
    [
      'invalid rate type',
      'voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    tts:\n      engine: macos-say\n      rate: "190"\n',
      'voice.autoCapture.tts.rate',
    ],
    [
      'rate below range',
      'voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    tts:\n      engine: macos-say\n      rate: 79\n',
      'voice.autoCapture.tts.rate',
    ],
    [
      'rate above range',
      'voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    tts:\n      engine: macos-say\n      rate: 501\n',
      'voice.autoCapture.tts.rate',
    ],
    [
      'phrases must be arrays',
      'voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    startPhrases: hey doom\n    tts:\n      engine: macos-say\n',
      'voice.autoCapture.startPhrases',
    ],
    [
      'phrases must be strings',
      'voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    startPhrases: [1]\n    tts:\n      engine: macos-say\n',
      'voice.autoCapture.startPhrases',
    ],
    [
      'blank phrase',
      'voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    startPhrases: [" "]\n    tts:\n      engine: macos-say\n',
      'non-empty strings',
    ],
    [
      'normalized duplicate phrase',
      'voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    startPhrases: ["Hey, Doom!", "hey doom"]\n    tts:\n      engine: macos-say\n',
      'normalized duplicates',
    ],
    [
      'cross-list duplicate phrase',
      'voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    startPhrases: ["Hey Doom"]\n    stopPhrases: ["hey, doom"]\n    tts:\n      engine: macos-say\n',
      'both startPhrases and stopPhrases',
    ],
  ])('rejects invalid autonomous config: %s', (_name, content, message) => {
    expect(() => parseDoomConfig(content, '/config.yaml')).toThrow(message);
  });
  it('rejects bounded autonomous phrase and voice violations', () => {
    const tooManyPhrases = Array.from({ length: 17 }, (_, index) => `phrase ${index}`)
      .map((phrase) => `      - ${phrase}`)
      .join('\n');
    expect(() =>
      parseDoomConfig(
        `voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    startPhrases:\n${tooManyPhrases}\n    tts:\n      engine: macos-say\n`,
        '/config.yaml',
      ),
    ).toThrow('at most 16');
    expect(() =>
      parseDoomConfig(
        `voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    stopPhrases: ["${'x'.repeat(65)}"]\n    tts:\n      engine: macos-say\n`,
        '/config.yaml',
      ),
    ).toThrow('at most 64');
    expect(() =>
      parseDoomConfig(
        'voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    stopPhrases: ["stop\\u0000now"]\n    tts:\n      engine: macos-say\n',
        '/config.yaml',
      ),
    ).toThrow('control characters');
    expect(() =>
      parseDoomConfig(
        `voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    tts:\n      engine: macos-say\n      voice: ${'x'.repeat(65)}\n`,
        '/config.yaml',
      ),
    ).toThrow('at most 64');
  });
  it('rejects unknown fields, invalid engines, and ambiguous models', () => {
    expect(() => parseDoomConfig('voice:\n  typo: true\n', '/config.yaml')).toThrow('unsupported voice field(s): typo');
    expect(() => parseDoomConfig('voice:\n  engine: cloud\n', '/config.yaml')).toThrow('voice.engine');
    expect(() =>
      parseDoomConfig(
        'voice:\n  adapters:\n    openai-whisper:\n      model:\n        path: /a\n        id: turbo\n',
        '/config.yaml',
      ),
    ).toThrow('exactly one');
    expect(() =>
      parseDoomConfig('voice:\n  adapters:\n    whisper-cpp:\n      model:\n        id: base\n', '/config.yaml'),
    ).toThrow('does not support');
    expect(() => parseDoomConfig('unknown: true\n', '/config.yaml')).toThrow('unsupported root');
    expect(() => parseDoomConfig('- invalid\n', '/config.yaml')).toThrow('must be a YAML object');
    expect(() => parseDoomConfig('modes: invalid\n', '/config.yaml')).toThrow('modes to be an object');
    expect(() => parseDoomConfig('modes:\n  planning:\n    main:\n      model: ""\n', '/config.yaml')).toThrow(
      'non-empty string',
    );
    expect(() => parseDoomConfig('voice:\n  recorder: invalid\n', '/config.yaml')).toThrow('voice.recorder');
    expect(() => parseDoomConfig('voice:\n  adapters: invalid\n', '/config.yaml')).toThrow('voice.adapters');
    expect(() => parseDoomConfig('voice:\n  adapters:\n    mlx-whisper: invalid\n', '/config.yaml')).toThrow(
      'mlx-whisper to be an object',
    );
    expect(() => parseDoomConfig('voice:\n  adapters:\n    mlx-whisper:\n      model: {}\n', '/config.yaml')).toThrow(
      'exactly one',
    );
    expect(() => parseDoomConfig('projectTrust: null\n', '/config.yaml')).toThrow('projectTrust must be');
  });
  it('deep merges voice and never inherits global project trust', () => {
    const home = temporaryRoot('doom-home-');
    const repo = temporaryRoot('doom-repo-');
    write(
      globalDoomConfigPath(home),
      `projectTrust: always\nvoice:\n  language: en\n  recorder:\n    binary: /bin/ffmpeg\n  adapters:\n    openai-whisper:\n      binary: /bin/whisper\n      model:\n        id: turbo\n`,
    );
    write(repositoryDoomConfigPath(repo), `voice:\n  recorder:\n    device: none:3\n`);
    expect(loadDoomConfig(repo, home)).toMatchObject({
      projectTrust: 'ask',
      voice: {
        language: 'en',
        recorder: { binary: '/bin/ffmpeg', device: 'none:3' },
        adapters: { 'openai-whisper': { model: { id: 'turbo' } } },
      },
    });
  });
  it('keeps autonomous voice global-only while preserving repository STT merging', () => {
    const home = temporaryRoot('doom-home-auto-');
    const repo = temporaryRoot('doom-repo-auto-');
    write(
      globalDoomConfigPath(home),
      `voice:
  autoCapture:
    model: openai/gpt-4.1-mini
    startPhrases: ["Hey Doom"]
    tts:
      engine: macos-say
`,
    );
    write(repositoryDoomConfigPath(repo), 'voice:\n  recorder:\n    device: none:4\n');
    expect(loadDoomConfig(repo, home)).toMatchObject({
      voice: {
        recorder: { device: 'none:4' },
        autoCapture: {
          model: 'openai/gpt-4.1-mini',
          startPhrases: ['Hey Doom'],
          tts: { engine: 'macos-say' },
        },
      },
    });

    write(
      repositoryDoomConfigPath(repo),
      'voice:\n  autoCapture:\n    model: openai/gpt-4.1\n    tts:\n      engine: macos-say\n',
    );
    expect(() => loadDoomConfig(repo, home)).toThrow('voice.autoCapture is global-only');
    expect(() =>
      mergeDoomConfigs(
        { projectTrust: 'ask' },
        {
          projectTrust: 'ask',
          voice: { autoCapture: { model: 'openai/gpt-4.1', tts: { engine: 'macos-say' } } },
        },
      ),
    ).toThrow('voice.autoCapture is global-only');
  });
  it('uses stable paths and singleton config service bindings', () => {
    const container = new Context();
    new DoomConfigService(container, configContext('/missing'), loadDoomConfig);
    expect(globalDoomConfigPath('/home/test')).toBe('/home/test/.pi/.doom/config.yaml');
    expect(repositoryDoomConfigPath('/repo')).toBe('/repo/.doom/config.yaml');
    // reflect.get hands back a context-bound proxy per call, so identity is not
    // the invariant; one registration answering under the service name is.
    expect(container.reflect.get(DOOM_CONFIG_SERVICE)).toBeDefined();
    expect((container.reflect.get(DOOM_CONFIG_SERVICE) as IDoomConfigService).load('/missing', '/missing')).toEqual({
      projectTrust: 'ask',
      modes: undefined,
      editor: undefined,
      voice: undefined,
    });
  });
  it('resolves planning storage from home, absolute, and repository-relative paths', () => {
    expect(resolvePlanningPlansDirectory(undefined, '/repo', '/home/test')).toBe('/home/test/.pi/plans');
    expect(resolvePlanningPlansDirectory('~/custom-plans', '/repo', '/home/test')).toBe('/home/test/custom-plans');
    expect(resolvePlanningPlansDirectory('/var/plans', '/repo', '/home/test')).toBe('/var/plans');
    expect(resolvePlanningPlansDirectory('.doom/plans', '/repo', '/home/test')).toBe('/repo/.doom/plans');
    expect(() => resolvePlanningPlansDirectory('~other/plans', '/repo', '/home/test')).toThrow('home aliases');
  });
  it('parses and merges repository planning storage over the global value', () => {
    const globalConfig = parseDoomConfig('modes:\n  planning:\n    plansDirectory: ~/global-plans\n', '/global.yaml');
    const repositoryConfig = parseDoomConfig(
      'modes:\n  planning:\n    plansDirectory: .doom/repository-plans\n',
      '/repo.yaml',
    );

    expect(mergeDoomConfigs(globalConfig, repositoryConfig).modes?.planning?.plansDirectory).toBe(
      '.doom/repository-plans',
    );
    expect(() => parseDoomConfig('modes:\n  planning:\n    plansDirectory: ""\n', '/config.yaml')).toThrow(
      'non-empty string',
    );
  });
  it('publishes the config service and merges planning, editor, and adapter fallbacks', () => {
    const probe = new Context();
    new DoomConfigService(probe, configContext('/missing'), loadDoomConfig);
    expect(probe.reflect.get(DOOM_CONFIG_SERVICE)).toBeDefined();
    expect(
      mergeDoomConfigs(
        {
          projectTrust: 'always',
          editor: { command: 'code' },
          modes: { planning: { main: { model: 'global', thinking: 'high' } } },
          voice: { adapters: { 'mlx-whisper': { binary: '/mlx', model: { id: 'base' } } } },
        },
        {
          projectTrust: 'never',
          modes: { planning: { main: { thinking: 'max' } } },
          voice: { adapters: { 'mlx-whisper': { model: { id: 'large' } } } },
        },
      ),
    ).toMatchObject({
      projectTrust: 'never',
      editor: { command: 'code' },
      modes: { planning: { main: { model: 'global', thinking: 'max' } } },
      voice: { adapters: { 'mlx-whisper': { binary: '/mlx', model: { id: 'large' } } } },
    });
  });
});
