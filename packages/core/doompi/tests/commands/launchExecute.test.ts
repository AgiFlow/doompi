import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LaunchCommand } from '../../src/commands/launchCommand.ts';
import { HARNESS_EVENT, type HarnessTelemetry } from '../../src/exports/logSinkTelemetry';
import type { HarnessContext } from '../../src/exports/services/harnessContext';

const spawnMock = vi.hoisted(() => vi.fn());
const runtimeBundleMocks = vi.hoisted(() => ({
  buildRuntimeBundle: vi.fn(),
  createRuntimeExtensionPlan: vi.fn(),
}));
vi.mock('cross-spawn', () => ({ default: spawnMock }));
vi.mock('../../src/adapters/runtimeBundle.ts', () => runtimeBundleMocks);

const realStdin = process.stdin;

/** Feeds the launcher a finished stdin, which is how vibe-lint invokes it. */
function replaceStdin(payload: string): void {
  const stream = new PassThrough();
  stream.end(payload);
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
}

function restoreStdin(): void {
  Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
}

/**
 * Waits until the command has actually spawned its child.
 *
 * The vibe-lint path drains stdin first, so emitting an exit before the spawn
 * would be delivered to nobody and the command would wait forever.
 */
async function waitForSpawn(): Promise<void> {
  for (let attempt = 0; attempt < 500 && spawnMock.mock.calls.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A child process stand-in whose exit the command awaits. */
class FakeChild extends EventEmitter {
  stdout: PassThrough | null;
  stderr: PassThrough | null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: NodeJS.Signals[] = [];

  constructor(piped: boolean) {
    super();
    this.stdout = piped ? new PassThrough() : null;
    this.stderr = piped ? new PassThrough() : null;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killed.push(signal);
    return true;
  }
}

function createTelemetry(): HarnessTelemetry & { errors: string[]; events: string[] } {
  const errors: string[] = [];
  const events: string[] = [];
  return {
    errors,
    events,
    recordError: async (event) => {
      errors.push(event);
    },
    recordWarning: async () => {},
    recordEvent: async (event) => {
      events.push(event);
    },
    runInSpan: async (_name, _attributes, callback) => callback(),
    flush: async () => {},
    shutdown: async () => {},
  } as HarnessTelemetry & { errors: string[]; events: string[] };
}

describe('LaunchCommand.execute', () => {
  let repoRoot: string;
  let themePath: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-launch-'));
    fs.mkdirSync(path.join(repoRoot, '.doom'), { recursive: true });
    // A consumer repository that declares no layer packages at all, which keeps
    // the launch under test independent of anything installed here.
    fs.writeFileSync(path.join(repoRoot, '.doom', 'modes.yaml'), 'layers: {}\nmajorMode:\n  minimal: []\n');
    themePath = path.join(repoRoot, 'theme.json');
    fs.writeFileSync(themePath, '{}');
    spawnMock.mockReset();
    runtimeBundleMocks.createRuntimeExtensionPlan.mockReturnValue({
      extensions: ['/parent.mjs'],
      childExtensions: ['/child.mjs'],
      fingerprint: 'composition-fingerprint',
      composition: {},
    });
    runtimeBundleMocks.buildRuntimeBundle.mockResolvedValue({
      bundle: '/cache/doom.mjs',
      manifest: '/cache/doom.manifest.json',
      compilerManifest: '/cache/compiler.manifest.json',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreStdin();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  function createContext(overrides: Partial<HarnessContext['options']> = {}): HarnessContext {
    const majorModesConfig = loadMajorModesConfig(repoRoot);
    return {
      options: {
        repoRoot,
        cwd: repoRoot,
        agents: false,
        autoStop: false,
        mute: true,
        piArgs: [],
        ...overrides,
      },
      environment: {},
      majorModesConfig,
      selectedLayers: [],
      defaultThemePath: themePath,
      cleanup: async () => {},
    } as unknown as HarnessContext;
  }

  it('spawns Pi with the assembled extensions and returns its exit code', async () => {
    const child = new FakeChild(false);
    spawnMock.mockReturnValue(child);
    const telemetry = createTelemetry();
    const context = createContext();

    const promise = new LaunchCommand().execute(context, telemetry);
    await waitForSpawn();
    child.emit('exit', 0, null);

    expect(await promise).toBe(0);
    const [, args, spawnOptions] = spawnMock.mock.calls[0] as [string, string[], { stdio: unknown }];
    expect(args).toContain('--no-themes');
    expect(args).toContain(themePath);
    expect(spawnOptions.stdio).toBe('inherit');
    expect(context.environment.ELICITATION_SESSION_ID).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('adapts canonical activation order to Pi CLI arguments at the launch boundary', async () => {
    const child = new FakeChild(false);
    spawnMock.mockReturnValue(child);
    runtimeBundleMocks.createRuntimeExtensionPlan.mockReturnValue({
      extensions: ['/first.mjs', '/second.mjs'],
      childExtensions: ['/child.mjs'],
      fingerprint: 'composition-fingerprint',
      composition: {},
    });
    runtimeBundleMocks.buildRuntimeBundle.mockRejectedValue(new Error('compiler unavailable'));
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const promise = new LaunchCommand().execute(createContext(), createTelemetry());
    await waitForSpawn();
    child.emit('exit', 0, null);
    await promise;

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const extensionArguments = args.filter((_argument, index) => args[index - 1] === '--extension');
    expect(extensionArguments).toEqual(['/first.mjs', '/second.mjs']);
  });

  it('publishes the child extension set for detached subagents', async () => {
    const child = new FakeChild(false);
    spawnMock.mockReturnValue(child);
    const context = createContext();

    const promise = new LaunchCommand().execute(context, createTelemetry());
    await waitForSpawn();
    child.emit('exit', 0, null);
    await promise;

    expect(JSON.parse(context.environment.DOOMPI_CHILD_EXTENSIONS ?? 'null')).toBeInstanceOf(Array);
  });

  it('maps a signalled exit onto its conventional code', async () => {
    const child = new FakeChild(false);
    spawnMock.mockReturnValue(child);

    const promise = new LaunchCommand().execute(createContext(), createTelemetry());
    await waitForSpawn();
    child.emit('exit', null, 'SIGINT');

    expect(await promise).toBeGreaterThan(128);
  });

  it('records a launch failure when Pi never starts', async () => {
    const child = new FakeChild(false);
    spawnMock.mockReturnValue(child);
    const telemetry = createTelemetry();

    const promise = new LaunchCommand().execute(createContext(), telemetry);
    await waitForSpawn();
    child.emit('error', new Error('spawn ENOENT'));

    await expect(promise).rejects.toThrow('spawn ENOENT');
    expect(telemetry.errors).toContain(HARNESS_EVENT.launchFailed);
  });

  it('records a config failure and rethrows when .doom/config.yaml is malformed', async () => {
    fs.writeFileSync(path.join(repoRoot, '.doom', 'config.yaml'), 'projectTrust: [not, a, string]\n');
    const telemetry = createTelemetry();

    await expect(new LaunchCommand().execute(createContext(), telemetry)).rejects.toThrow();
    expect(telemetry.errors).toContain(HARNESS_EVENT.configLoadFailed);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('pipes stdio and wraps the response for a vibe-lint invocation', async () => {
    const child = new FakeChild(true);
    spawnMock.mockReturnValue(child);
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    replaceStdin(JSON.stringify({ prompt: 'Review', systemPrompt: 'Reply as JSON' }));

    const promise = new LaunchCommand().execute(createContext({ outputFormat: 'vibe-lint' }), createTelemetry());
    await waitForSpawn();
    child.stdout?.write('  reviewed  ');
    child.emit('exit', 0, null);

    expect(await promise).toBe(0);
    const [, args, spawnOptions] = spawnMock.mock.calls[0] as [string, string[], { stdio: unknown }];
    expect(args).toContain('--print');
    expect(args).toContain('--no-session');
    expect(spawnOptions.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(written.join('')).toContain('"content"');
  });

  it('leaves the response unwritten when a vibe-lint run exits non-zero', async () => {
    const child = new FakeChild(true);
    spawnMock.mockReturnValue(child);
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    replaceStdin(JSON.stringify({ prompt: 'Review', systemPrompt: 'Reply as JSON' }));

    const promise = new LaunchCommand().execute(createContext({ outputFormat: 'vibe-lint' }), createTelemetry());
    await waitForSpawn();
    child.emit('exit', 2, null);

    expect(await promise).toBe(2);
    expect(written.join('')).not.toContain('"content"');
  });

  it('matches every invocation, since it is the default command', () => {
    expect(new LaunchCommand().matches({} as HarnessContext['options'])).toBe(true);
  });
});
