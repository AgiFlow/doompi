import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessContext } from '../../src/adapters/harnessContext';
import type { HarnessTelemetry } from '../../src/exports/logSinkTelemetry';
import { LAUNCHER_COMPOSITION_ENV } from '../../src/types/interfaces/launcherComposition';

const runtimeBundleMocks = vi.hoisted(() => ({
  buildRuntimeBundle: vi.fn(),
  createRuntimeExtensionPlan: vi.fn(),
}));
vi.mock('../../src/adapters/runtimeBundle.ts', () => runtimeBundleMocks);

const { resolveLaunchPlan } = await import('../../src/adapters/launchPlan.ts');

const FINGERPRINT = 'f'.repeat(64);
const BUNDLE = '/cache/dist/copilot.ffffffffffff.mjs';
const ENTRIES = ['/pkg/a/pi.mjs', '/pkg/b/pi.mjs'];

let workDir: string;

const telemetry = {
  recordError: vi.fn(async () => undefined),
  recordEvent: vi.fn(() => undefined),
} as unknown as HarnessTelemetry;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-launch-plan-'));
  runtimeBundleMocks.createRuntimeExtensionPlan.mockReturnValue({
    extensions: [...ENTRIES],
    childExtensions: ['/pkg/a/pi.mjs'],
    fingerprint: FINGERPRINT,
    composition: {},
  });
  runtimeBundleMocks.buildRuntimeBundle.mockResolvedValue({ bundle: BUNDLE });
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function context(): HarnessContext {
  return {
    options: {
      repoRoot: '/workspace/repo',
      cwd: '/workspace/repo',
      agents: true,
      autoStop: false,
      mute: true,
      preset: 'ollama',
      piArgs: [],
    },
    environment: {},
    defaultThemePath: '/themes/doom.json',
    resources: { skillDirectories: [] },
    plugins: [],
    cleanup: async () => {},
  } as unknown as HarnessContext;
}

function extensionArgs(piArgs: string[]): string[] {
  return piArgs.filter((_, index) => piArgs[index - 1] === '--extension');
}

describe('resolveLaunchPlan composition record', () => {
  it('hands Pi the aggregate directly when no record is requested', async () => {
    const plan = await resolveLaunchPlan(context(), telemetry);

    expect(extensionArgs(plan.piArgs)).toEqual([BUNDLE]);
    expect(plan.environment[LAUNCHER_COMPOSITION_ENV]).toBeUndefined();
  });

  it('swaps the aggregate for one stable entry when a record is requested', async () => {
    const record = path.join(workDir, 'composition.json');

    const plan = await resolveLaunchPlan(context(), telemetry, { compositionRecordPath: record });

    // A fingerprint-named path would freeze the composition for the process;
    // this entry resolves the selection on every load instead.
    const [entry] = extensionArgs(plan.piArgs);
    expect(entry).toMatch(/launcherBootstrap\.(mjs|ts)$/);
    expect(entry).not.toBe(BUNDLE);
    expect(plan.environment[LAUNCHER_COMPOSITION_ENV]).toBe(record);
  });

  it('records the launch identity and keeps the aggregate as the fast path', async () => {
    const record = path.join(workDir, 'composition.json');

    await resolveLaunchPlan(context(), telemetry, { compositionRecordPath: record });

    expect(JSON.parse(fs.readFileSync(record, 'utf8'))).toEqual({
      version: 1,
      root: '/workspace/repo',
      preset: 'ollama',
      mute: true,
      autoStop: false,
      agents: true,
      bundles: { [FINGERPRINT]: BUNDLE },
    });
  });

  it('records no aggregate when compilation fell back to individual entries', async () => {
    runtimeBundleMocks.buildRuntimeBundle.mockRejectedValue(new Error('compiler unavailable'));
    const record = path.join(workDir, 'composition.json');

    const plan = await resolveLaunchPlan(context(), telemetry, { compositionRecordPath: record });

    // The entry still loads: it resolves the sources itself when the record
    // names no aggregate for the selected composition.
    expect(JSON.parse(fs.readFileSync(record, 'utf8')).bundles).toEqual({});
    expect(extensionArgs(plan.piArgs)[0]).toMatch(/launcherBootstrap\.(mjs|ts)$/);
  });
});
