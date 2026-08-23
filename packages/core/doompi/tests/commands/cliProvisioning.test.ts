import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessContext } from '../../src/adapters/harnessContext.ts';
import type { HarnessTelemetry } from '../../src/adapters/telemetry/logSinkTelemetry.ts';
import { CliApp } from '../../src/commands/cli/cliApp.ts';
import type { HarnessOptions } from '../../src/types/interfaces/harness.ts';

const mocks = vi.hoisted(() => ({
  buildHarnessContext: vi.fn(),
  ensureLayerPackages: vi.fn(),
}));

vi.mock('../../src/adapters/harnessContext.ts', () => ({ buildHarnessContext: mocks.buildHarnessContext }));
vi.mock('../../src/adapters/layerPackageInstaller.ts', () => ({
  ensureLayerPackages: mocks.ensureLayerPackages,
}));

function options(): HarnessOptions {
  return {
    repoRoot: '/repo',
    cwd: '/repo',
    domains: [],
    majorMode: 'copilot',
    explain: false,
    pluginDirectories: [],
    additionalDirectories: [],
    preset: 'default',
    outputFormat: 'native',
    mute: false,
    automation: false,
    autoStop: false,
    sandbox: false,
    allowProtectedWrites: false,
    hooks: true,
    mcp: true,
    agents: true,
    piArgs: [],
  };
}

describe('CliApp package provisioning', () => {
  const cleanup = vi.fn();
  const execute = vi.fn();
  const telemetry = {
    recordError: vi.fn(),
    recordWarning: vi.fn(),
    recordEvent: vi.fn(),
    runInSpan: vi.fn((_name, _attributes, callback: () => Promise<number>) => callback()),
    flush: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as HarnessTelemetry;
  const context = {
    options: options(),
    environment: { PI_CODING_AGENT_DIR: '/agent' },
    majorModesConfig: { defaultMajorMode: 'copilot', layers: {}, majorMode: {} },
    selectedLayers: ['team'],
    cleanup,
  } as unknown as HarnessContext;

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup.mockResolvedValue(undefined);
    execute.mockResolvedValue(0);
    mocks.buildHarnessContext.mockResolvedValue(context);
    mocks.ensureLayerPackages.mockResolvedValue([]);
  });

  it('installs the active configured package set before command execution', async () => {
    const app = new CliApp(telemetry);
    vi.spyOn(app, 'selectCommand').mockResolvedValue({ execute } as never);

    await expect(app.runHarness(options())).resolves.toBe(0);

    expect(mocks.ensureLayerPackages).toHaveBeenCalledWith({
      repoRoot: '/repo',
      config: context.majorModesConfig,
      layers: ['team'],
      environment: context.environment,
    });
    expect(mocks.ensureLayerPackages.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]!);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('cleans up and reports the failure when installation fails', async () => {
    const app = new CliApp(telemetry);
    vi.spyOn(app, 'selectCommand').mockResolvedValue({ execute } as never);
    mocks.ensureLayerPackages.mockRejectedValue(new Error('install failed'));

    await expect(app.runHarness(options())).rejects.toThrow('install failed');

    expect(execute).not.toHaveBeenCalled();
    expect(telemetry.recordError).toHaveBeenCalledWith('doom_pi.cli_failed', expect.any(Error));
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
