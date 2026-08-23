import { DOOMPI_SANDBOX_ENV } from '@agimon-ai/doompi-extension-contracts/sandbox-harness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessTelemetry } from '../../src/adapters/telemetry/logSinkTelemetry';
import { SandboxLaunchCommand } from '../../src/commands/sandboxLaunchCommand';
import type { HarnessContext } from '../../src/exports/services/harnessContext';
import type { HarnessOptions } from '../../src/types/interfaces/harness';

const adapterMocks = vi.hoisted(() => ({
  resolveSandboxHarnessEntry: vi.fn(),
  loadSandboxHarness: vi.fn(),
}));

vi.mock('../../src/adapters/sandboxHarness.ts', () => adapterMocks);

function options(overrides: Partial<HarnessOptions> = {}): HarnessOptions {
  return {
    repoRoot: '/repo',
    cwd: '/repo',
    domains: ['default'],
    majorMode: 'copilot',
    explain: false,
    pluginDirectories: [],
    additionalDirectories: [],
    preset: 'default',
    outputFormat: 'native',
    mute: false,
    automation: false,
    autoStop: false,
    sandbox: true,
    allowProtectedWrites: false,
    hooks: true,
    mcp: true,
    agents: true,
    piArgs: ['run'],
    ...overrides,
  };
}

function createContext(environment: NodeJS.ProcessEnv = {}): HarnessContext {
  return {
    options: options(),
    environment,
    majorModesConfig: { defaultMajorMode: 'copilot', majorMode: {}, layers: {} },
    selectedLayers: ['sandbox'],
    cleanup: async () => {},
  } as unknown as HarnessContext;
}

function createTelemetry(): HarnessTelemetry & { errors: string[]; events: string[] } {
  const errors: string[] = [];
  const events: string[] = [];
  return {
    errors,
    events,
    recordError: async (event: string) => {
      errors.push(event);
    },
    recordEvent: async (event: string) => {
      events.push(event);
    },
    runInSpan: async (_name: string, _attributes: unknown, callback: () => Promise<number>) => callback(),
  } as unknown as HarnessTelemetry & { errors: string[]; events: string[] };
}

describe('SandboxLaunchCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('matches only launches that asked for the sandbox', () => {
    const command = new SandboxLaunchCommand();

    expect(command.matches(options())).toBe(true);
    expect(command.matches(options({ sandbox: false }))).toBe(false);
  });

  it('refuses to nest inside an existing sandbox', async () => {
    const command = new SandboxLaunchCommand();

    await expect(command.execute(createContext({ [DOOMPI_SANDBOX_ENV]: '1' }), createTelemetry())).rejects.toThrowError(
      /nested --sandbox/,
    );
    expect(adapterMocks.resolveSandboxHarnessEntry).not.toHaveBeenCalled();
  });

  it('explains how to add a provider when the composition has none', async () => {
    adapterMocks.resolveSandboxHarnessEntry.mockReturnValue(undefined);

    await expect(new SandboxLaunchCommand().execute(createContext(), createTelemetry())).rejects.toThrowError(
      /add a sandbox layer to "copilot"/,
    );
  });

  it('delegates the launch and reports the provider exit code', async () => {
    const launchSandbox = vi.fn().mockResolvedValue(3);
    adapterMocks.resolveSandboxHarnessEntry.mockReturnValue({ specifier: './layers/sbx', entry: '/repo/harness.mjs' });
    adapterMocks.loadSandboxHarness.mockResolvedValue({ launchSandbox });
    const telemetry = createTelemetry();

    await expect(new SandboxLaunchCommand().execute(createContext(), telemetry)).resolves.toBe(3);

    expect(adapterMocks.loadSandboxHarness).toHaveBeenCalledWith('/repo/harness.mjs');
    const request = launchSandbox.mock.calls[0]?.[0] as {
      repoRoot: string;
      cwd: string;
      forwardArgs: string[];
      onProgress?: (message: string) => void;
    };
    expect(request.repoRoot).toBe('/repo');
    expect(request.cwd).toBe('/repo');
    expect(request.forwardArgs).not.toContain('--sandbox');
    expect(request.forwardArgs).toContain('--major-mode');
    expect(request.forwardArgs).toContain('run');
    expect(telemetry.events).toContain('doom_pi.launch_completed');
    expect(telemetry.errors).toEqual([]);
  });

  it('records a launch failure before rethrowing the provider error', async () => {
    adapterMocks.resolveSandboxHarnessEntry.mockReturnValue({ specifier: './layers/sbx', entry: '/repo/harness.mjs' });
    adapterMocks.loadSandboxHarness.mockResolvedValue({
      launchSandbox: vi.fn().mockRejectedValue(new Error('engine missing')),
    });
    const telemetry = createTelemetry();

    await expect(new SandboxLaunchCommand().execute(createContext(), telemetry)).rejects.toThrowError(/engine missing/);
    expect(telemetry.errors).toContain('doom_pi.launch_failed');
  });
});
