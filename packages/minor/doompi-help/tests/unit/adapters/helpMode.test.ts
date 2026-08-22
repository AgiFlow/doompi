import type { DoomHelpDiagnostic, DoomHelpSkill } from '@agimon-ai/doompi-extension-contracts/help';
import type { MinorModeCatalogService } from '@agimon-ai/doompi-extension-contracts/mode';
import type { DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HelpActivationService, HelpRuntimeState } from '../../../src/types/help.ts';

const mocks = vi.hoisted(() => ({
  modeDefinition: undefined as
    | {
        descriptor: {
          id: string;
          order?: number;
          actions: Array<{ id: string; contexts: string[] }>;
        };
        handleAction(
          actionId: string,
          argumentsValue: Record<string, unknown>,
          execution: { signal: AbortSignal },
        ): Promise<{ message?: string } | undefined>;
      }
    | undefined,
  modePublish: vi.fn(),
  modeDispose: vi.fn(),
  leaderContribution: undefined as
    | { source: string; bindings: Array<{ path: Array<{ key: string }>; action?: { name: string } }> }
    | undefined,
  leaderUpdate: vi.fn(),
  leaderDispose: vi.fn(),
  actionOptions: undefined as
    | {
        handlers: Record<
          string,
          (context: { hasUI: boolean; ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>
        >;
        onError(
          error: unknown,
          action: unknown,
          context: { hasUI: boolean; ui: { notify: ReturnType<typeof vi.fn> } },
        ): void;
      }
    | undefined,
  actionDispose: vi.fn(),
}));

vi.mock('@agimon-ai/doompi-extension-contracts/mode', () => ({
  registerMinorModeOwner: (_host: unknown, definition: NonNullable<typeof mocks.modeDefinition>) => {
    mocks.modeDefinition = definition;
    return { publish: mocks.modePublish, dispose: mocks.modeDispose };
  },
}));

import {
  HELP_LEADER_ACTION,
  HELP_MODE_ID,
  HELP_MODE_ORDER,
  helpMinorModeState,
  registerHelpModeIntegration,
  registerHelpUiIntegration,
} from '../../../src/adapters/pi/helpMode.ts';

const catalog = {} as MinorModeCatalogService;

function uiHub(): DoomUiHubService {
  return {
    registerLeader(contribution: NonNullable<typeof mocks.leaderContribution>) {
      mocks.leaderContribution = contribution;
      return { update: mocks.leaderUpdate, dispose: mocks.leaderDispose };
    },
    registerLeaderActions(options: NonNullable<typeof mocks.actionOptions>) {
      mocks.actionOptions = options as NonNullable<typeof mocks.actionOptions>;
      return mocks.actionDispose;
    },
    registerFooter: vi.fn(),
    registerConfig: vi.fn(),
  } as unknown as DoomUiHubService;
}

function runtimeState(
  activation: HelpRuntimeState['activation'],
  skills: readonly DoomHelpSkill[] = [],
  diagnostics: readonly DoomHelpDiagnostic[] = [],
): HelpRuntimeState {
  return { activation, skills, diagnostics };
}

function activationFixture(initialState = runtimeState('inactive')): {
  activation: HelpActivationService;
  publish(state: HelpRuntimeState): void;
} {
  let state = initialState;
  const listeners = new Set<(next: HelpRuntimeState) => void>();
  const publish = (next: HelpRuntimeState): void => {
    state = next;
    for (const listener of listeners) listener(next);
  };
  const activate = vi.fn(async () => {
    const next = runtimeState('active', [
      {
        name: 'doompi-help',
        description: 'Help guidance.',
        filePath: '/tmp/SKILL.md',
        baseDir: '/tmp',
        source: '@agimon-ai/doompi-help',
      },
    ]);
    publish(next);
    return next;
  });
  const deactivate = vi.fn(() => {
    const next = runtimeState('inactive');
    publish(next);
    return next;
  });
  return {
    activation: {
      getState: () => state,
      replaceContributions: vi.fn(),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      activate,
      deactivate,
      dispose: vi.fn(),
    },
    publish,
  };
}

beforeEach(() => {
  mocks.modeDefinition = undefined;
  mocks.leaderContribution = undefined;
  mocks.actionOptions = undefined;
  mocks.modePublish.mockReset();
  mocks.modeDispose.mockReset();
  mocks.leaderUpdate.mockReset();
  mocks.leaderDispose.mockReset();
  mocks.actionDispose.mockReset();
});

describe('helpMinorModeState', () => {
  it('maps inactive, activating, active, and degraded runtime states', () => {
    expect(helpMinorModeState(runtimeState('inactive'))).toMatchObject({
      activation: 'inactive',
      condition: 'ready',
      actions: [
        { id: 'activate', enabled: true },
        { id: 'deactivate', enabled: false },
      ],
    });
    expect(helpMinorModeState(runtimeState('activating'))).toMatchObject({
      activation: 'activating',
      condition: 'queued',
    });
    expect(
      helpMinorModeState(
        runtimeState('active', [
          {
            name: 'help',
            description: 'Help.',
            filePath: '/tmp/SKILL.md',
            baseDir: '/tmp',
            source: '@agimon-ai/package',
          },
        ]),
      ),
    ).toMatchObject({ activation: 'active', condition: 'ready', detail: '1 package Help skill' });
    expect(
      helpMinorModeState(
        runtimeState('degraded', [], [{ source: 'package', code: 'FAILED', message: 'partial failure' }]),
      ),
    ).toMatchObject({ activation: 'active', condition: 'degraded', color: 'warning' });
  });

  it('surfaces a bounded inactive activation failure', () => {
    const state = helpMinorModeState(
      runtimeState('inactive', [], [{ source: 'package', code: 'FAILED', message: 'x'.repeat(300) }]),
    );

    expect(state.condition).toBe('failed');
    expect(state.detail).toHaveLength(160);
  });
});

describe('registerHelpModeIntegration', () => {
  it('registers order 50 headless actions and SPC h e', () => {
    const fixture = activationFixture();
    const integration = registerHelpModeIntegration(catalog, fixture.activation);
    const disposeUi = registerHelpUiIntegration(uiHub(), fixture.activation);

    expect(mocks.modeDefinition?.descriptor).toMatchObject({
      id: HELP_MODE_ID,
      order: HELP_MODE_ORDER,
      actions: [
        { id: 'activate', contexts: ['tui', 'headless'] },
        { id: 'deactivate', contexts: ['tui', 'headless'] },
      ],
    });
    expect(mocks.leaderContribution).toMatchObject({
      bindings: [{ path: [{ key: 'h' }, { key: 'e' }], action: { name: HELP_LEADER_ACTION } }],
    });

    integration.dispose();
    integration.dispose();
    disposeUi();
    disposeUi();
    expect(mocks.actionDispose).toHaveBeenCalledOnce();
    expect(mocks.leaderDispose).toHaveBeenCalledOnce();
    expect(mocks.modeDispose).toHaveBeenCalledOnce();
  });

  it('routes mode actions and the leader toggle through one activation service', async () => {
    const fixture = activationFixture();
    registerHelpModeIntegration(catalog, fixture.activation);
    registerHelpUiIntegration(uiHub(), fixture.activation);
    const signal = new AbortController().signal;

    await mocks.modeDefinition?.handleAction('activate', {}, { signal });
    expect(fixture.activation.activate).toHaveBeenCalledWith(signal);
    await mocks.modeDefinition?.handleAction('deactivate', {}, { signal });
    expect(fixture.activation.deactivate).toHaveBeenCalledOnce();
    await expect(mocks.modeDefinition?.handleAction('unknown', {}, { signal })).rejects.toThrow(
      'Unknown Help mode action',
    );

    const notify = vi.fn();
    await mocks.actionOptions?.handlers[HELP_LEADER_ACTION]?.({ hasUI: true, ui: { notify } });
    expect(fixture.activation.activate).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith('Package Help activated.', 'info');

    await mocks.actionOptions?.handlers[HELP_LEADER_ACTION]?.({ hasUI: false, ui: { notify } });
    expect(fixture.activation.deactivate).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
    mocks.actionOptions?.onError('leader failed', HELP_LEADER_ACTION, { hasUI: true, ui: { notify } });
    expect(notify).toHaveBeenCalledWith('leader failed', 'error');
    expect(mocks.leaderUpdate).toHaveBeenCalled();
    expect(mocks.modePublish).toHaveBeenCalled();
  });
});
