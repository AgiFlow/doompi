import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDoomConfig } from '@agimon-ai/doompi-config';
import type { ResolvedVoiceConfig } from '@agimon-ai/doompi-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  catalogEntryById,
  ENGINE_TOOLING,
  engineGroupLabel,
  formatBytes,
  MAX_GROUP_LENGTH,
  resolveInstaller,
  VOICE_CATALOG,
} from '../src/services/catalog.ts';
import { downloadModelFile, isDownloaded } from '../src/adapters/audio/download.ts';
import { planBlocker, planInstall, UNSUPPORTED_PLATFORM } from '../src/adapters/audio/install.ts';
import type { IExecutableResolver, IProcessSpawner, ProcessResult, RunningProcess } from '../src/types/index.ts';
import { VoiceConfigController } from '../src/adapters/pi/voiceConfig';

const WHISPER_CPP_TURBO = 'whisper-cpp/large-v3-turbo';
const MLX_TURBO = 'mlx-community/whisper-large-v3-turbo';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-voice-config-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const configPath = (): string => path.join(home, '.pi', '.doom', 'config.yaml');
const readConfig = () => parseDoomConfig(fs.readFileSync(configPath(), 'utf8'), configPath());

/** Backed by a live set, so a test can make an install actually provide a binary. */
function resolverFor(present: Set<string>): IExecutableResolver {
  return {
    resolve(configured, fallback) {
      const name = configured ?? fallback;
      if (present.has(path.basename(name))) return `/opt/bin/${path.basename(name)}`;
      throw new Error(`Required executable not found on PATH: ${name}`);
    },
  };
}

function spawnerRecording(
  calls: string[][],
  result: ProcessResult = { code: 0, stdout: '', stderr: '' },
): IProcessSpawner {
  return {
    start(): RunningProcess {
      throw new Error('not used');
    },
    async run(executable, args) {
      calls.push([executable, ...args]);
      return result;
    },
  };
}

/** A fetch that serves fixed bytes with a content-length, like the real CDN. */
function fetchServing(bytes: Uint8Array): typeof globalThis.fetch {
  return (async () =>
    new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    })) as unknown as typeof globalThis.fetch;
}

/**
 * A stand-in for doom-runner's terminal.
 *
 * `hold` keeps a command running so a test can inspect the panel mid-install;
 * `prompt` makes it look like the command is waiting on an answer.
 */
function fakeTerminal(options: {
  commands: string[];
  hold?: boolean;
  prompt?: string;
  exitCode?: number;
  /** Binaries the command puts on the machine, as a real installer would. */
  provides?: { set: Set<string>; binaries: readonly string[] };
}) {
  const answers: string[] = [];
  let settle: (() => void) | undefined;
  const run = async (request: { command: string }) => {
    options.commands.push(request.command);
    for (const binary of options.provides?.binaries ?? []) options.provides?.set.add(binary);
    let resolveExit: (code: number) => void = () => undefined;
    const completion = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const finish = (): void => resolveExit(options.exitCode ?? 0);
    if (options.hold) settle = finish;
    else finish();
    return {
      completion,
      tail: () => (options.prompt ? [options.prompt] : []),
      awaitingInput: () => Boolean(options.prompt),
      answer: (text: string) => {
        answers.push(text);
        finish();
      },
      stop: () => finish(),
    };
  };
  return { answers, run, release: () => settle?.() };
}

function controller(options: {
  /** Pass a Set to share it with a terminal that provides binaries. */
  present?: readonly string[] | Set<string>;
  calls?: string[][];
  commands?: string[];
  runCommand?: (request: { id: string; name: string; command: string; cwd: string }) => Promise<never>;
  terminal?: ReturnType<typeof fakeTerminal>;
  fetchImpl?: typeof globalThis.fetch;
  platform?: NodeJS.Platform;
  /** Reads the config back, for the fields whose display and guards depend on it. */
  loadVoice?: () => ResolvedVoiceConfig | undefined;
  listModels?: () => readonly { provider: string; id: string }[];
}) {
  const republish = vi.fn();
  const present = options.present instanceof Set ? options.present : new Set(options.present ?? []);
  const terminal = options.terminal ?? fakeTerminal({ commands: options.commands ?? [] });
  const instance = new VoiceConfigController(
    {
      resolver: resolverFor(present),
      spawner: spawnerRecording(options.calls ?? []),
      loadVoice: options.loadVoice ?? ((): undefined => undefined),
      ...(options.listModels ? { listModels: options.listModels } : {}),
      homeDirectory: home,
      platform: options.platform ?? 'darwin',
      cwd: () => home,
      ...(options.runCommand ? { runCommand: options.runCommand } : { runCommand: terminal.run }),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    },
    republish,
  );
  return { instance, present, republish, terminal };
}

describe('voice catalog', () => {
  it('gives whisper-cpp entries a download and the python engines none', () => {
    for (const entry of VOICE_CATALOG) {
      expect(ENGINE_TOOLING[entry.engine]).toBeDefined();
      // whisper-cpp cannot take a model id at all, so it is the only engine we
      // fetch a file for.
      expect(Boolean(entry.download)).toBe(entry.engine === 'whisper-cpp');
      if (entry.download) expect(entry.download.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(catalogEntryById(WHISPER_CPP_TURBO)?.sizeBytes).toBe(1_624_555_275);
    expect(catalogEntryById('nope')).toBeUndefined();
  });

  it('keeps every group label inside the contract cap', async () => {
    const { instance } = controller({ present: [] });
    await instance.refresh();
    const choices = instance.sections()[0]?.fields.find((field) => field.id === 'model')?.choices ?? [];
    // The wire schema caps these and rejects the whole snapshot past any of them,
    // which takes the extension's registration down rather than truncating.
    for (const choice of choices) {
      expect((choice.group ?? '').length).toBeLessThanOrEqual(MAX_GROUP_LENGTH);
      expect(choice.label.length).toBeLessThanOrEqual(96);
      expect(choice.id.length).toBeLessThanOrEqual(256);
      expect((choice.detail ?? '').length).toBeLessThanOrEqual(96);
      expect((choice.statusText ?? '').length).toBeLessThanOrEqual(96);
    }
    const section = instance.sections()[0];
    expect(section?.title.length).toBeLessThanOrEqual(32);
    expect((section?.detail ?? '').length).toBeLessThanOrEqual(96);
    for (const field of section?.fields ?? []) {
      expect(field.label.length).toBeLessThanOrEqual(48);
      expect((field.detail ?? '').length).toBeLessThanOrEqual(240);
      expect((field.keyPath ?? '').length).toBeLessThanOrEqual(128);
    }
    expect(engineGroupLabel('openai-whisper').length).toBeLessThanOrEqual(MAX_GROUP_LENGTH);
  });

  it('checks shared engine binaries once while refreshing the catalog concurrently', async () => {
    const resolve = vi.fn(() => {
      throw new Error('not installed');
    });
    const instance = new VoiceConfigController(
      {
        resolver: { resolve },
        spawner: spawnerRecording([]),
        loadVoice: () => undefined,
        homeDirectory: home,
      },
      () => undefined,
    );

    await instance.refresh();

    const binaries = new Set(
      VOICE_CATALOG.filter((entry) => !entry.download).map((entry) => ENGINE_TOOLING[entry.engine].binary),
    );
    expect(resolve).toHaveBeenCalledTimes(binaries.size);
  });

  it('keeps the confirmation summary inside the status cap', async () => {
    const { instance } = controller({ present: [] });
    await instance.refresh();
    await instance.handlers().install?.({ fieldId: 'model', value: WHISPER_CPP_TURBO });
    const model = instance.sections()[0]?.fields.find((field) => field.id === 'model');
    // The longest case: nothing installed, so every command is listed.
    expect((model?.statusText ?? '').length).toBeLessThanOrEqual(240);
  });

  it('formats sizes at each magnitude', () => {
    expect(formatBytes(undefined)).toBeUndefined();
    expect(formatBytes(77_691_713)).toBe('78 MB');
    expect(formatBytes(1_624_555_275)).toBe('1.6 GB');
    expect(formatBytes(4_096)).toBe('4 KB');
  });
});

describe('planInstall', () => {
  it('marks satisfied steps rather than hiding them', () => {
    const entry = catalogEntryById(WHISPER_CPP_TURBO);
    const plan = planInstall(entry!, {
      platform: 'darwin',
      find: (binary) => (binary === 'ffmpeg' || binary === 'whisper-cli' ? `/opt/bin/${binary}` : undefined),
      modelPresent: true,
    });
    expect(plan.commands).toEqual([]);
    expect(plan.steps.filter((step) => step.state === 'pending').map((step) => step.kind)).toEqual([
      'config',
      'verify',
    ]);
  });

  it('lists every command it would run when nothing is present', () => {
    const entry = catalogEntryById(WHISPER_CPP_TURBO);
    const plan = planInstall(entry!, {
      platform: 'darwin',
      find: (binary) => (binary === 'brew' ? '/opt/bin/brew' : undefined),
      modelPresent: false,
    });
    expect(plan.commands).toEqual(['brew install ffmpeg', 'brew install whisper-cpp']);
  });

  it('prefers brew, then pip3, then pip', () => {
    const entry = catalogEntryById('turbo');
    const withBrew = planInstall(entry!, {
      platform: 'darwin',
      find: (binary) =>
        binary === 'ffmpeg' ? '/f' : binary === 'brew' || binary === 'pip3' ? `/${binary}` : undefined,
      modelPresent: false,
    });
    expect(withBrew.commands).toEqual(['brew install openai-whisper']);

    const withPip3 = planInstall(entry!, {
      platform: 'darwin',
      find: (binary) => (binary === 'ffmpeg' ? '/f' : binary === 'pip3' || binary === 'pip' ? `/${binary}` : undefined),
      modelPresent: false,
    });
    expect(withPip3.commands).toEqual(['pip3 install -U openai-whisper']);

    const withPipOnly = planInstall(entry!, {
      platform: 'darwin',
      find: (binary) => (binary === 'ffmpeg' ? '/f' : binary === 'pip' ? '/pip' : undefined),
      modelPresent: false,
    });
    expect(withPipOnly.commands).toEqual(['pip install -U openai-whisper']);
  });

  it('says what is missing rather than failing later with ENOENT', () => {
    // mlx-whisper has no brew formula, so with no pip at all there is no route in.
    const entry = catalogEntryById(MLX_TURBO);
    const plan = planInstall(entry!, {
      platform: 'darwin',
      find: (binary) => (binary === 'ffmpeg' ? '/f' : undefined),
      modelPresent: false,
    });
    expect(planBlocker(plan)).toBe('no installer found: needs pip3 or pip on PATH');
    expect(plan.commands).toEqual([]);
  });

  it('offers brew for the engines that have a formula, and pip for the one that does not', () => {
    const find = (binary: string): string | undefined => `/opt/bin/${binary}`;
    expect(resolveInstaller('whisper-cpp', find)?.command).toBe('brew install whisper-cpp');
    expect(resolveInstaller('openai-whisper', find)?.command).toBe('brew install openai-whisper');
    // Verified against the Homebrew formulae API: there is no mlx-whisper formula.
    expect(resolveInstaller('mlx-whisper', find)?.command).toBe('pip3 install -U mlx-whisper');
    expect(resolveInstaller('mlx-whisper', () => undefined)).toBeUndefined();
  });

  it('skips the download entirely for an id-based engine', () => {
    const entry = catalogEntryById(MLX_TURBO);
    const plan = planInstall(entry!, { platform: 'darwin', find: () => '/opt/bin/mlx_whisper', modelPresent: false });
    expect(plan.commands).toEqual([]);
    expect(plan.steps.some((step) => step.label.startsWith('download'))).toBe(false);
  });

  it('fails preflight off macOS, because the recorder cannot run there', () => {
    const entry = catalogEntryById(WHISPER_CPP_TURBO);
    const plan = planInstall(entry!, { platform: 'linux', find: () => undefined, modelPresent: false });
    expect(plan.steps[0]?.state).toBe('failed');
    expect(plan.steps[0]?.detail).toBe(UNSUPPORTED_PLATFORM);
  });
});

describe('downloadModelFile', () => {
  it('publishes only after the checksum matches, and reports progress', async () => {
    const bytes = new TextEncoder().encode('model-bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const target = path.join(home, 'models', 'ggml-tiny.bin');
    const progress: number[] = [];

    await downloadModelFile(
      { url: 'https://example/model', targetPath: target, sha256, onProgress: (p) => progress.push(p.receivedBytes) },
      fetchServing(bytes),
    );

    expect(fs.readFileSync(target, 'utf8')).toBe('model-bytes');
    expect(progress.at(-1)).toBe(bytes.byteLength);
    expect(await isDownloaded(target, bytes.byteLength)).toBe(true);
    expect(await isDownloaded(target, 999)).toBe(false);
    expect(await isDownloaded(path.join(home, 'missing.bin'), undefined)).toBe(false);
  });

  it('writes nothing and leaves no temp file when the checksum is wrong', async () => {
    const bytes = new TextEncoder().encode('tampered');
    const target = path.join(home, 'models', 'ggml-tiny.bin');

    await expect(
      downloadModelFile(
        { url: 'https://example/model', targetPath: target, sha256: 'f'.repeat(64) },
        fetchServing(bytes),
      ),
    ).rejects.toThrow('Checksum mismatch');

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(path.join(home, 'models'))).toEqual([]);
  });

  it('reports a failed response rather than writing a body-less file', async () => {
    const failing = (async () => new Response('nope', { status: 404 })) as unknown as typeof globalThis.fetch;
    await expect(
      downloadModelFile(
        { url: 'https://example/model', targetPath: path.join(home, 'models', 'x.bin'), sha256: 'a'.repeat(64) },
        failing,
      ),
    ).rejects.toThrow('Download failed with 404');
  });
});

describe('VoiceConfigController', () => {
  it('offers install for a missing model and select for a present one', async () => {
    const { instance } = controller({ present: ['mlx_whisper'] });
    await instance.refresh();
    const choices = instance.sections()[0]?.fields.find((field) => field.id === 'model')?.choices ?? [];

    const mlx = choices.find((choice) => choice.id === MLX_TURBO);
    const whisper = choices.find((choice) => choice.id === WHISPER_CPP_TURBO);
    // mlx_whisper is on PATH and fetches its own model, so it is ready to use.
    expect(mlx).toMatchObject({ action: 'select', status: 'ready' });
    expect(whisper).toMatchObject({ action: 'install', status: 'available', statusText: 'download' });
    expect(whisper?.group).toContain('whisper-cpp');
  });

  it('selects an installed id-based model by writing engine and id together', async () => {
    const { instance } = controller({ present: ['mlx_whisper'] });
    await instance.refresh();
    await instance.handlers().select?.({ fieldId: 'model', value: MLX_TURBO });

    const config = readConfig();
    expect(config.voice?.engine).toBe('mlx-whisper');
    expect(config.voice?.adapters?.['mlx-whisper']?.model).toEqual({ id: MLX_TURBO });
  });

  it('asks before running anything, and names every command', async () => {
    const calls: string[][] = [];
    const { instance } = controller({ present: ['brew'], calls });
    await instance.refresh();
    await instance.handlers().install?.({ fieldId: 'model', value: WHISPER_CPP_TURBO });

    const model = instance.sections()[0]?.fields.find((field) => field.id === 'model');
    // In `detail`, which the panel wraps under the row, not right-aligned as a
    // status where it ran off the edge of the pane.
    expect(model?.detail).toContain('brew install whisper-cpp');
    expect(model?.actions?.map((action) => action.action)).toEqual(['confirm', 'cancel']);
    // Nothing has run and nothing is written until the confirmation arrives.
    expect(calls).toEqual([]);
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it('runs the plan on confirm and writes config only at the end', async () => {
    const entry = catalogEntryById(WHISPER_CPP_TURBO);
    const bytes = new TextEncoder().encode('ggml');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // Point the catalog entry at bytes we control rather than the real CDN.
    const patched = { ...entry!, sizeBytes: bytes.byteLength, download: { ...entry!.download!, sha256 } };
    const commands: string[] = [];
    const present = new Set(['ffmpeg', 'brew']);
    const terminal = fakeTerminal({ commands, provides: { set: present, binaries: ['whisper-cli'] } });
    const { instance } = controller({ present, terminal, fetchImpl: fetchServing(bytes) });
    vi.spyOn(await import('../src/services/catalog.ts'), 'catalogEntryById').mockReturnValue(patched);

    await instance.refresh();
    await instance.handlers().install?.({ fieldId: 'model', value: WHISPER_CPP_TURBO });
    await instance.handlers().confirm?.({ fieldId: 'model' });

    // Run as one shell command on the terminal, not argv through a spawner: the
    // terminal is a login shell, which is how brew is found at all.
    expect(commands).toEqual(['brew install whisper-cpp']);
    const config = readConfig();
    expect(config.voice?.engine).toBe('whisper-cpp');
    expect(config.voice?.adapters?.['whisper-cpp']?.model.path).toContain('ggml-large-v3-turbo.bin');
    expect(config.voice?.adapters?.['whisper-cpp']?.model.id).toBeUndefined();
  });

  it('publishes the whole plan while installing, with the running step marked', async () => {
    const present = new Set(['ffmpeg', 'pip3']);
    // The install actually provides the binary, so the verify step can pass.
    const terminal = fakeTerminal({ commands: [], hold: true, provides: { set: present, binaries: ['whisper'] } });
    const { instance } = controller({ present, terminal });
    await instance.refresh();
    await instance.handlers().install?.({ fieldId: 'model', value: 'turbo' });
    const running = instance.handlers().confirm?.({ fieldId: 'model' });

    const model = instance.sections()[0]?.fields.find((field) => field.id === 'model');
    expect(model?.busy).toBe(true);
    // Every step, not just the current one, so what already ran stays visible.
    expect(model?.steps?.map((step) => step.label)).toEqual([
      'preflight',
      'install whisper',
      'model',
      'write config',
      'verify',
    ]);
    expect(model?.steps?.find((step) => step.label === 'preflight')?.state).toBe('satisfied');

    terminal.release();
    await running;
  });

  it('shows the terminal tail and takes an answer when a command asks', async () => {
    const present = new Set(['ffmpeg', 'pip3']);
    const terminal = fakeTerminal({
      commands: [],
      hold: true,
      prompt: 'Proceed with installation? [Y/n]',
      provides: { set: present, binaries: ['whisper'] },
    });
    const { instance } = controller({ present, terminal });
    await instance.refresh();
    await instance.handlers().install?.({ fieldId: 'model', value: 'turbo' });
    const running = instance.handlers().confirm?.({ fieldId: 'model' });

    // The terminal handle is attached a microtask after confirm, so the panel
    // only learns about the prompt on the republish that follows.
    await vi.waitFor(() =>
      expect(instance.sections()[0]?.fields.find((field) => field.id === 'model')?.output).toBeDefined(),
    );
    const model = instance.sections()[0]?.fields.find((field) => field.id === 'model');
    expect(model?.output).toEqual(['Proceed with installation? [Y/n]']);
    // Without this the panel has no reason to offer a line to type into.
    expect(model?.awaitingInput).toBe(true);

    await instance.handlers().input?.({ fieldId: 'model', value: 'y' });
    expect(terminal.answers).toEqual(['y']);
    await running;
  });

  it('reports the failing command rather than a bare exit code', async () => {
    const terminal = fakeTerminal({ commands: [], exitCode: 1 });
    const { instance } = controller({ present: ['ffmpeg', 'pip3'], terminal });
    await instance.refresh();
    await instance.handlers().install?.({ fieldId: 'model', value: 'turbo' });
    await expect(instance.handlers().confirm?.({ fieldId: 'model' })).rejects.toThrow(
      'pip3 install -U openai-whisper` exited with code 1',
    );
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it('says so rather than running blind when no terminal is available', async () => {
    const { instance } = controller({ present: ['ffmpeg'], runCommand: undefined });
    const noTerminal = new VoiceConfigController(
      {
        resolver: resolverFor(new Set(['ffmpeg', 'pip3'])),
        spawner: spawnerRecording([]),
        loadVoice: () => undefined,
        homeDirectory: home,
        platform: 'darwin',
      },
      vi.fn(),
    );
    void instance;
    await noTerminal.refresh();
    await noTerminal.handlers().install?.({ fieldId: 'model', value: 'turbo' });
    await expect(noTerminal.handlers().confirm?.({ fieldId: 'model' })).rejects.toThrow('no terminal is available');
  });

  it('refuses to plan an install this machine cannot support', async () => {
    const { instance } = controller({ present: [], platform: 'linux' });
    await instance.refresh();
    await instance.handlers().install?.({ fieldId: 'model', value: WHISPER_CPP_TURBO });
    expect(instance.sections()[0]?.notice).toBe(UNSUPPORTED_PLATFORM);
  });

  it('cancels a pending confirmation without writing', async () => {
    const { instance } = controller({ present: [] });
    await instance.refresh();
    await instance.handlers().install?.({ fieldId: 'model', value: WHISPER_CPP_TURBO });
    await instance.handlers().cancel?.({ fieldId: 'model' });
    expect(instance.sections()[0]?.fields.find((field) => field.id === 'model')?.actions).toBeUndefined();
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it('writes and clears the simple text fields', async () => {
    const { instance } = controller({ present: [] });
    await instance.handlers().set?.({ fieldId: 'language', value: 'en' });
    expect(readConfig().voice?.language).toBe('en');
    await instance.handlers().set?.({ fieldId: 'recorder.device', value: ':1' });
    expect(readConfig().voice?.recorder?.device).toBe(':1');
    await instance.handlers().clear?.({ fieldId: 'language' });
    expect(readConfig().voice?.language).toBeUndefined();
    // An unknown field is ignored rather than writing a stray key.
    await instance.handlers().set?.({ fieldId: 'nope', value: 'x' });
    expect(readConfig().voice?.recorder?.device).toBe(':1');
  });

  it('writes the autonomous capture fields, splitting phrase lists and parsing numbers', async () => {
    const { instance } = controller({
      present: [],
      loadVoice: () => readConfig().voice as ResolvedVoiceConfig | undefined,
    });

    await instance.handlers().set?.({ fieldId: 'autoCapture.model', value: 'openai-codex/gpt-5.6-luna' });
    await instance.refresh();
    await instance.handlers().set?.({ fieldId: 'autoCapture.startPhrases', value: 'hey doom, ok doom' });
    await instance.handlers().set?.({ fieldId: 'autoCapture.utteranceIdleMs', value: '3000' });
    await instance.handlers().set?.({ fieldId: 'autoCapture.tts.engine', value: 'macos-say' });
    await instance.handlers().set?.({ fieldId: 'autoCapture.tts.voice', value: 'Samantha' });
    await instance.handlers().set?.({ fieldId: 'autoCapture.tts.rate', value: '190' });

    const auto = readConfig().voice?.autoCapture;
    expect(auto?.model).toBe('openai-codex/gpt-5.6-luna');
    // A list field is written as a list, not as the comma string it was typed as.
    expect(auto?.startPhrases).toEqual(['hey doom', 'ok doom']);
    expect(auto?.utteranceIdleMs).toBe(3000);
    expect(auto?.tts).toEqual({ engine: 'macos-say', voice: 'Samantha', rate: 190 });
  });

  it('refuses a non-numeric value for a number field rather than writing a string', async () => {
    const { instance } = controller({
      present: [],
      loadVoice: () => readConfig().voice as ResolvedVoiceConfig | undefined,
    });
    await instance.handlers().set?.({ fieldId: 'autoCapture.model', value: 'openai-codex/gpt-5.6-luna' });

    await instance.handlers().set?.({ fieldId: 'autoCapture.utteranceIdleMs', value: 'soon' });

    expect(readConfig().voice?.autoCapture?.utteranceIdleMs).toBeUndefined();
    expect(instance.sections()[0]?.notice).toContain('takes a number');
  });

  it('shows every autonomous capture setting the config file supports', async () => {
    const { instance } = controller({
      present: [],
      loadVoice: () => readConfig().voice as ResolvedVoiceConfig | undefined,
    });
    await instance.handlers().set?.({ fieldId: 'autoCapture.model', value: 'openai-codex/gpt-5.6-luna' });
    await instance.refresh();
    await instance.handlers().set?.({ fieldId: 'autoCapture.stopPhrases', value: 'stop speaking' });
    await instance.refresh();

    const fields = instance.sections()[0]?.fields ?? [];
    const byId = new Map(fields.map((field) => [field.id, field]));
    for (const id of [
      'autoCapture.model',
      'autoCapture.startPhrases',
      'autoCapture.stopPhrases',
      'autoCapture.utteranceIdleMs',
      'autoCapture.tts.engine',
      'autoCapture.tts.voice',
      'autoCapture.tts.rate',
    ]) {
      expect(byId.has(id)).toBe(true);
    }
    expect(byId.get('autoCapture.model')?.value).toBe('openai-codex/gpt-5.6-luna');
    expect(byId.get('autoCapture.stopPhrases')?.value).toBe('stop speaking');
  });

  it('offers the session models for the hands-free model rather than free text', async () => {
    const { instance } = controller({
      present: [],
      loadVoice: () => readConfig().voice as ResolvedVoiceConfig | undefined,
      listModels: () => [
        { provider: 'openai-codex', id: 'gpt-5.6-luna' },
        { provider: 'anthropic', id: 'claude-opus-5' },
      ],
    });

    const field = instance.sections()[0]?.fields.find((entry) => entry.id === 'autoCapture.model');

    expect(field?.kind).toBe('choice');
    expect(field?.choices?.map((choice) => choice.id)).toEqual([
      'openai-codex/gpt-5.6-luna',
      'anthropic/claude-opus-5',
    ]);
    // Selecting one writes the spec the config file expects.
    await instance.handlers().set?.({ fieldId: 'autoCapture.model', value: 'anthropic/claude-opus-5' });
    expect(readConfig().voice?.autoCapture?.model).toBe('anthropic/claude-opus-5');
  });

  it('falls back to typing a model when the session offers none', () => {
    const { instance } = controller({ present: [] });

    expect(instance.sections()[0]?.fields.find((entry) => entry.id === 'autoCapture.model')?.kind).toBe('text');
  });

  it('picks a language from a list, where auto clears the setting', async () => {
    const { instance } = controller({
      present: [],
      loadVoice: () => readConfig().voice as ResolvedVoiceConfig | undefined,
    });
    const language = instance.sections()[0]?.fields.find((entry) => entry.id === 'language');

    expect(language?.kind).toBe('choice');
    expect(language?.choices?.[0]).toMatchObject({ id: 'auto', action: 'clear' });
    expect(language?.choices?.map((choice) => choice.id)).toContain('vi');

    await instance.handlers().set?.({ fieldId: 'language', value: 'vi' });
    expect(readConfig().voice?.language).toBe('vi');
    await instance.handlers().clear?.({ fieldId: 'language' });
    expect(readConfig().voice?.language).toBeUndefined();
  });

  it('surfaces a failure as a section notice', async () => {
    const { instance } = controller({ present: [] });
    instance.reportError(new Error('read only'));
    expect(instance.sections()[0]?.notice).toBe('read only');
    expect(instance.sections()[0]?.noticeLevel).toBe('error');
  });

  it('reports the engine as derived, never as an editable field', async () => {
    const { instance } = controller({ present: [] });
    await instance.refresh();
    const engine = instance.sections()[0]?.fields.find((field) => field.id === 'engine');
    expect(engine?.kind).toBe('info');
  });

  it('refuses a second install while one is running', async () => {
    const bytes = new TextEncoder().encode('ggml');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const entry = catalogEntryById(WHISPER_CPP_TURBO);
    const patched = { ...entry!, sizeBytes: bytes.byteLength, download: { ...entry!.download!, sha256 } };
    const catalog = await import('../src/services/catalog.ts');
    vi.spyOn(catalog, 'catalogEntryById').mockReturnValue(patched);

    // Hold the download open so a second install arrives mid-flight.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowFetch = (async () => {
      await gate;
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
    }) as unknown as typeof globalThis.fetch;

    const { instance } = controller({ present: ['ffmpeg', 'whisper-cli'], fetchImpl: slowFetch });
    await instance.refresh();
    await instance.handlers().install?.({ fieldId: 'model', value: WHISPER_CPP_TURBO });
    const running = instance.handlers().confirm?.({ fieldId: 'model' });

    await instance.handlers().install?.({ fieldId: 'model', value: WHISPER_CPP_TURBO });
    expect(instance.sections()[0]?.notice).toBe('An install is already running.');
    expect(instance.sections()[0]?.detail).toBe('installing');

    release();
    await running;
  });

  it('aborts a running install without writing config', async () => {
    const entry = catalogEntryById(WHISPER_CPP_TURBO);
    const catalog = await import('../src/services/catalog.ts');
    vi.spyOn(catalog, 'catalogEntryById').mockReturnValue(entry!);
    const neverResolving = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as unknown as typeof globalThis.fetch;

    const { instance } = controller({ present: ['ffmpeg', 'whisper-cli'], fetchImpl: neverResolving });
    await instance.refresh();
    await instance.handlers().install?.({ fieldId: 'model', value: WHISPER_CPP_TURBO });
    const running = instance.handlers().confirm?.({ fieldId: 'model' });
    await instance.handlers().abort?.({ fieldId: 'model' });

    await expect(running).rejects.toThrow();
    // Config is written last, so an abort leaves the previous setup untouched.
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it('draws even when the config file will not parse', async () => {
    const republish = vi.fn();
    const instance = new VoiceConfigController(
      {
        resolver: resolverFor(new Set()),
        spawner: spawnerRecording([]),
        loadVoice: () => {
          throw new Error('voice.engine must be one of');
        },
        homeDirectory: home,
        platform: 'darwin',
      },
      republish,
    );
    // The panel is where someone would go to repair it, so it has to render.
    expect(instance.sections()[0]?.notice).toContain('voice.engine');
    expect(instance.sections()[0]?.fields).not.toHaveLength(0);
  });

  it('recognises the active model from a configured file path', async () => {
    const entry = catalogEntryById(WHISPER_CPP_TURBO);
    const modelPath = path.join(home, '.pi', '.doom', 'models', entry!.download!.fileName);
    const republish = vi.fn();
    const instance = new VoiceConfigController(
      {
        resolver: resolverFor(new Set(['whisper-cli'])),
        spawner: spawnerRecording([]),
        loadVoice: () => ({
          engine: 'whisper-cpp',
          language: 'auto',
          recorder: { device: 'none:default' },
          adapters: { 'whisper-cpp': { model: { path: modelPath } } },
        }),
        homeDirectory: home,
        platform: 'darwin',
      },
      republish,
    );
    const model = instance.sections()[0]?.fields.find((field) => field.id === 'model');
    expect(model?.value).toBe(WHISPER_CPP_TURBO);
    expect(instance.sections()[0]?.detail).toBe('ready');
    expect(instance.sections()[0]?.fields.find((field) => field.id === 'engine')?.value).toBe('whisper-cpp');
  });
});
