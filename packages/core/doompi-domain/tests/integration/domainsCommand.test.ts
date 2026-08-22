import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createHarnessSession,
  disposeHarnessState,
  getHarnessState,
  resetHarnessStore,
  snapshotHarnessState,
  updateHarnessState,
} from '@agimon-ai/doompi-config/harnessStore';
import type { HarnessState } from '@agimon-ai/doompi-config/types';
import type { TransitionOutcome } from '@agimon-ai/doompi-extension-contracts/transition';
import {
  createDoomVoiceToolsService,
  DOOM_VOICE_TOOLS_SERVICE,
} from '@agimon-ai/doompi-extension-contracts/voice-tools';
import {
  createVoiceReloadHandoffStore,
  type VoiceReloadHandoffStore,
} from '@agimon-ai/doompi-extension-contracts/voice-reload-handoff';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDomainSwitchHandoffStore } from '../../src/adapters/domainSwitchHandoff.ts';
import {
  type DomainCatalogPort,
  type DomainsCommandDependencies,
  registerDomainsCommand,
} from '../../src/commands/domainsCommand.ts';
import { DOMAIN_EVENT, type DomainTelemetry } from '../../src/types/telemetry.ts';
import { bindStubCoordinator } from '../helpers/coordinator.ts';
import { bindConfig, harnessContext } from '../helpers/session.ts';

const persistHarnessSelection = vi.hoisted(() => vi.fn());
const pickerConstructed = vi.hoisted(() => vi.fn());

vi.mock('@agimon-ai/doompi-config/piContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  persistHarnessSelection,
}));
vi.mock('@agimon-ai/doompi-ui/components/matrixPicker', () => ({
  MatrixPickerComponent: class MatrixPickerComponent {
    constructor(...args: unknown[]) {
      pickerConstructed(...args);
    }
  },
}));

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

const SESSION_ID = 'domains-command-session';
const events: string[] = [];
const recordedErrors: unknown[] = [];
const telemetry: DomainTelemetry = {
  recordEvent: async (event) => {
    events.push(event);
  },
  recordError: async (event, error) => {
    events.push(event);
    recordedErrors.push(error);
  },
};

let root: string;
let disposeAll: Array<() => void> = [];

function setup(
  options: {
    mode?: 'rpc' | 'tui';
    outcome?: TransitionOutcome;
    strategy?: 'pi-reload' | 'process-relaunch';
    picked?: string[] | undefined;
    catalog?: Partial<DomainCatalogPort>;
    applyDomains?: DomainsCommandDependencies['applyDomains'];
  } = {},
) {
  const order: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const commands = new Map<string, CommandHandler>();
  const pi = {
    on: vi.fn(),
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
    registerCommand: vi.fn((name: string, definition: { handler: CommandHandler }) => {
      commands.set(name, definition.handler);
    }),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    mode: options.mode ?? 'rpc',
    ui: {
      notify: vi.fn((message: string, level: string) => {
        order.push('notify');
        notifications.push({ message, level });
      }),
      custom: vi.fn(async (factory: (...args: unknown[]) => unknown) => {
        factory(undefined, {}, {}, vi.fn());
        return options.picked;
      }),
    },
    sessionManager: { getSessionId: () => SESSION_ID, getBranch: () => [] },
    waitForIdle: vi.fn(async () => {
      order.push('wait');
    }),
    reload: vi.fn(async () => {
      order.push('reload');
    }),
  } as unknown as ExtensionCommandContext & ExtensionContext;

  const cordis = new Context();
  bindConfig(cordis, root);
  disposeAll.push(() => void cordis.fiber.dispose());
  const voiceTools = createDoomVoiceToolsService<ExtensionContext>(`domain-command-test:${crypto.randomUUID()}`);
  const voiceSession = voiceTools.bindSession(SESSION_ID, ctx);
  voiceSession.setActive(true);
  cordis.provide(DOOM_VOICE_TOOLS_SERVICE, voiceTools);
  disposeAll.push(() => {
    voiceSession.dispose();
    voiceTools.dispose();
  });
  const coordinatorBinding = bindStubCoordinator(
    cordis,
    SESSION_ID,
    { domains: ['default'], majorMode: 'copilot', layers: [] },
    options.outcome ?? 'applied',
    options.strategy,
  );
  disposeAll.push(coordinatorBinding.dispose);

  const handoffs = createDomainSwitchHandoffStore();
  const reloadHandoffs = createVoiceReloadHandoffStore({
    now: () => Date.now(),
    createToken: () => crypto.randomUUID(),
  });
  disposeAll.push(() => {
    handoffs.dispose();
  });
  const catalog: DomainCatalogPort = {
    list: async () => ({ active: ['default'], effective: ['default'], available: ['default', 'development'] }),
    validate: async (_ctx, values) => [...values],
    describe: async () => ({ default: 'default tools', development: 'development tools' }),
    completions: async () => undefined,
    ...options.catalog,
  };
  const applyDomains =
    options.applyDomains ??
    vi.fn(async (_domains: string[], state) => {
      order.push('apply');
      return state as HarnessState;
    });
  persistHarnessSelection.mockImplementation(() => order.push('persist'));

  registerDomainsCommand(pi, telemetry, {
    cordisContext: () => cordis,
    catalog,
    handoffs,
    reloadHandoffs,
    applyDomains,
    loadConfigJournal: () => import('@agimon-ai/doompi-config/piContext'),
    loadPicker: () => import('@agimon-ai/doompi-ui/components/matrixPicker'),
  });

  const handler = commands.get('domains');
  if (!handler) throw new Error('the domains command was not registered');
  return {
    applyDomains,
    coordinator: coordinatorBinding.coordinator,
    ctx,
    handler,
    handoffs,
    reloadHandoffs,
    notifications,
    order,
    pi,
    voiceSession,
    voiceTools,
  };
}

/**
 * A parked voice handoff, exactly as the voice tool would have issued it.
 *
 * The service only prepares reload continuity for an active Voice session, so
 * this fixture supplies the same generation-fenced identity the tool receives.
 */
function queueVoiceSwitch(
  handoffs: ReturnType<typeof createDomainSwitchHandoffStore>,
  reloadHandoffs: VoiceReloadHandoffStore,
  hostGeneration: string,
  domains: string[],
): { readonly commandToken: string; readonly reloadToken: string } {
  const reload = reloadHandoffs.prepare(
    {
      active: true,
      sessionId: SESSION_ID,
      hostGeneration,
    },
    {
      operationId: 'voice-operation',
      domains,
    },
  );
  const commandToken = handoffs.issue({
    sessionId: SESSION_ID,
    hostGeneration,
    operationId: 'voice-operation',
    domains,
    reloadHandoffToken: reload.token,
  }).token;
  return { commandToken, reloadToken: reload.token };
}

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  recordedErrors.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'domains-command-'));
});

afterEach(() => {
  for (const dispose of disposeAll.reverse()) dispose();
  disposeAll = [];
  delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
  delete process.env.PI_SUBAGENT_EXTRA_SKILL_DIRS;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('/domains', () => {
  it('prints the selection when called with no argument outside the TUI', async () => {
    const { handler, ctx, notifications, order } = setup();

    await handler('', ctx);

    expect(notifications[0]?.message).toContain('Active domains: default');
    expect(order).toEqual(['notify']);
  });

  it('preserves wait, apply, persist, notify, and reload ordering', async () => {
    const { applyDomains, ctx, handler, order, pi } = setup();

    await handler('development', ctx);

    expect(order).toEqual(['wait', 'apply', 'persist', 'notify', 'reload']);
    expect(applyDomains).toHaveBeenCalledWith(['development'], expect.objectContaining({ root }));
    expect(persistHarnessSelection).toHaveBeenCalledWith(pi, expect.objectContaining({ root }));
    expect(events).toEqual([DOMAIN_EVENT.domainsSwitched]);
  });

  it('splits a comma-separated argument into the requested set', async () => {
    const { applyDomains, ctx, handler } = setup();

    await handler(' development , default ', ctx);

    expect(applyDomains).toHaveBeenCalledWith(['development', 'default'], expect.anything());
  });

  it('opens the multi-select in the TUI and switches to what it confirms', async () => {
    const { applyDomains, ctx, handler } = setup({ mode: 'tui', picked: ['development'] });

    await handler('', ctx);

    expect(pickerConstructed).toHaveBeenCalledOnce();
    expect(pickerConstructed.mock.calls[0]?.[0]).toMatchObject({
      title: 'Domains (active: default)',
      multi: true,
      selected: ['default'],
      items: [
        { value: 'default', label: 'default', description: 'default tools' },
        { value: 'development', label: 'development', description: 'development tools' },
      ],
    });
    expect(applyDomains).toHaveBeenCalledWith(['development'], expect.anything());
  });

  it('does nothing at all when the picker is dismissed', async () => {
    const { applyDomains, ctx, handler, order } = setup({ mode: 'tui', picked: undefined });

    await handler('', ctx);

    expect(applyDomains).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it('reports the selection unchanged without reloading', async () => {
    const { ctx, handler, notifications, order } = setup({ outcome: 'unchanged' });

    await handler('default', ctx);

    expect(notifications[0]).toEqual({ message: 'Domains already active: default', level: 'info' });
    expect(order).toEqual(['notify']);
  });

  it('reports a relaunch-bound switch as queued rather than applied', async () => {
    const { ctx, handler, order } = setup({ strategy: 'process-relaunch' });

    await handler('development', ctx);

    expect(order).toEqual(['wait', 'apply', 'persist', 'notify', 'reload']);
  });

  it('surfaces a refused transition as an error notification', async () => {
    const { ctx, handler, notifications, order } = setup({ outcome: 'rejected' });

    await handler('development', ctx);

    expect(notifications[0]?.level).toBe('error');
    expect(notifications[0]?.message).toContain('Domain transition was rejected');
    expect(order).toEqual(['notify']);
    expect(events).toEqual([DOMAIN_EVENT.domainsSwitchFailed]);
  });

  it('does not reload when staging the selection failed', async () => {
    const { ctx, handler, notifications, order } = setup({
      applyDomains: vi.fn(async () => {
        throw new Error('staging failed');
      }),
    });

    await handler('development', ctx);

    expect(notifications[0]).toEqual({ message: 'staging failed', level: 'error' });
    expect(order).toEqual(['wait', 'notify']);
  });

  it('restores the subagent projection when selection persistence fails', async () => {
    process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = 'active-agents';
    process.env.PI_SUBAGENT_EXTRA_SKILL_DIRS = 'active-skills';
    const { ctx, handler, notifications, order } = setup({
      applyDomains: vi.fn(async (_domains, state) => {
        process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = 'candidate-agents';
        process.env.PI_SUBAGENT_EXTRA_SKILL_DIRS = 'candidate-skills';
        return state as HarnessState;
      }),
    });
    persistHarnessSelection.mockImplementationOnce(() => {
      throw new Error('journal failed');
    });

    await handler('development', ctx);

    expect(process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS).toBe('active-agents');
    expect(process.env.PI_SUBAGENT_EXTRA_SKILL_DIRS).toBe('active-skills');
    expect(notifications[0]).toEqual({ message: 'journal failed', level: 'error' });
    expect(order).toEqual(['wait', 'notify']);
  });

  it('rejects an unknown domain before any transition is planned', async () => {
    const { ctx, handler, notifications } = setup({
      catalog: {
        validate: async () => {
          throw new Error('Unknown domain: ghost');
        },
      },
    });

    await handler('ghost', ctx);

    expect(notifications[0]).toEqual({ message: 'Unknown domain: ghost', level: 'error' });
  });

  it('applies a parked voice selection and commits its reload handoff', async () => {
    const { applyDomains, ctx, handler, handoffs, order, reloadHandoffs, voiceSession } = setup();
    const { commandToken } = queueVoiceSwitch(handoffs, reloadHandoffs, voiceSession.hostGeneration, ['development']);

    await handler(`--voice-switch-token=${commandToken}`, ctx);

    expect(applyDomains).toHaveBeenCalledWith(['development'], expect.anything());
    expect(order).toEqual(['wait', 'apply', 'persist', 'notify', 'reload']);
  });

  it('reloads an unchanged voice switch so the follow-up does not strand the session', async () => {
    const { ctx, handler, handoffs, order, reloadHandoffs, voiceSession } = setup({ outcome: 'unchanged' });
    const { commandToken } = queueVoiceSwitch(handoffs, reloadHandoffs, voiceSession.hostGeneration, ['default']);

    await handler(`--voice-switch-token=${commandToken}`, ctx);

    expect(order).toEqual(['notify', 'wait', 'reload']);
  });

  it('refuses a token that belongs to no live handoff', async () => {
    const { ctx, handler, notifications } = setup();

    await handler('--voice-switch-token=doom-domain-switch:missing', ctx);

    expect(notifications[0]?.message).toContain('stale or belongs to another session');
  });

  it('refuses a token after the Voice session rebinds to a new host generation', async () => {
    const { applyDomains, ctx, handler, handoffs, notifications, reloadHandoffs, voiceSession, voiceTools } = setup();
    const staleGeneration = voiceSession.hostGeneration;
    const { commandToken } = queueVoiceSwitch(handoffs, reloadHandoffs, staleGeneration, ['development']);
    voiceSession.dispose();
    const rebound = voiceTools.bindSession(SESSION_ID, ctx);
    rebound.setActive(true);

    try {
      await handler(`--voice-switch-token=${commandToken}`, ctx);

      expect(notifications[0]?.message).toContain('stale or belongs to another session');
      expect(applyDomains).not.toHaveBeenCalled();
      expect(handoffs.consume(commandToken, { sessionId: SESSION_ID, hostGeneration: staleGeneration })).toBeDefined();
    } finally {
      rebound.dispose();
    }
  });

  it('refuses a malformed token rather than treating it as a domain name', async () => {
    const { applyDomains, ctx, handler, notifications } = setup();

    await handler('--voice-switch-token=abc extra', ctx);

    expect(notifications[0]?.message).toContain('only command argument');
    expect(applyDomains).not.toHaveBeenCalled();
  });

  it('discards the parked handoff when the switch behind it fails', async () => {
    const { ctx, handler, handoffs, reloadHandoffs, voiceSession } = setup({
      applyDomains: vi.fn(async () => {
        throw new Error('staging failed');
      }),
    });
    const { commandToken } = queueVoiceSwitch(handoffs, reloadHandoffs, voiceSession.hostGeneration, ['development']);

    await handler(`--voice-switch-token=${commandToken}`, ctx);

    expect(
      handoffs.consume(commandToken, { sessionId: SESSION_ID, hostGeneration: voiceSession.hostGeneration }),
    ).toBeUndefined();
  });

  it('restores live, persisted, and coordinator selection when reload rejects', async () => {
    const original = snapshotHarnessState();
    const active = structuredClone(harnessContext(root)) as HarnessState;
    createHarnessSession(active, { directory: path.join(root, 'session'), environment: process.env });
    process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = 'active-agents';
    process.env.PI_SUBAGENT_EXTRA_SKILL_DIRS = 'active-skills';

    try {
      const { coordinator, ctx, handler, pi } = setup({
        applyDomains: vi.fn(async (domains) => {
          process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = 'candidate-agents';
          process.env.PI_SUBAGENT_EXTRA_SKILL_DIRS = 'candidate-skills';
          return updateHarnessState({ domains });
        }),
      });
      vi.mocked(ctx.reload).mockRejectedValueOnce(new Error('reload failed'));

      await expect(handler('development', ctx)).rejects.toThrow('reload failed');

      expect(getHarnessState().domains).toEqual(['default']);
      expect(process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS).toBe('active-agents');
      expect(process.env.PI_SUBAGENT_EXTRA_SKILL_DIRS).toBe('active-skills');
      expect(persistHarnessSelection).toHaveBeenNthCalledWith(
        1,
        pi,
        expect.objectContaining({ domains: ['development'] }),
      );
      expect(persistHarnessSelection).toHaveBeenNthCalledWith(2, pi, expect.objectContaining({ domains: ['default'] }));
      expect(
        coordinator.plan({
          sessionId: SESSION_ID,
          hostGeneration: coordinator.hostGeneration,
          operationId: 'after-failed-reload',
          source: 'command',
          target: { axis: 'domains', domains: ['development'] },
        }).previous.domains,
      ).toEqual(['default']);
    } finally {
      disposeHarnessState();
      for (const [key, value] of Object.entries(original.environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetHarnessStore();
    }
  });

  it('discards a committed voice handoff when reload rejects', async () => {
    const { ctx, handler, handoffs, reloadHandoffs, voiceSession } = setup();
    const { commandToken, reloadToken } = queueVoiceSwitch(handoffs, reloadHandoffs, voiceSession.hostGeneration, [
      'development',
    ]);
    vi.mocked(ctx.reload).mockRejectedValueOnce(new Error('reload failed'));

    await expect(handler(`--voice-switch-token=${commandToken}`, ctx)).rejects.toThrow('reload failed');

    expect(reloadHandoffs.consume(SESSION_ID, reloadToken)).toBeUndefined();
  });

  it('preserves the original reload error when journal compensation also fails', async () => {
    const reloadError = new Error('reload failed');
    const { ctx, handler } = setup();
    persistHarnessSelection
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('rollback journal failed');
      });
    vi.mocked(ctx.reload).mockRejectedValueOnce(reloadError);

    await expect(handler('development', ctx)).rejects.toBe(reloadError);

    expect(recordedErrors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('rollback journal failed') }),
    ]);
  });
});
