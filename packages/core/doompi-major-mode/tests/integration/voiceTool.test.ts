import { readHarnessState } from '@agimon-ai/doompi-config/harnessState';
import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { provideDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import { createDoomVoiceToolsService } from '@agimon-ai/doompi-extension-contracts/voice-tools';
import { createVoiceReloadHandoffStore } from '@agimon-ai/doompi-extension-contracts/voice-reload-handoff';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMajorModeVoiceCapability } from '../../src/adapters/pi/voiceTool.ts';
import type { MajorModeView } from '../../src/types/majorMode.ts';
import { bindStubCoordinator } from '../helpers/coordinator.ts';

const config: MajorModesConfig = {
  defaultMajorMode: 'copilot',
  layers: { team: { baseDirectory: '/repo' }, plan: { baseDirectory: '/repo' } },
  majorMode: {
    minimal: { description: 'Lean mode.', layers: ['team'] },
    copilot: { description: 'Full mode.', layers: ['team', 'plan'] },
  },
};

let disposeAll: Array<() => void> = [];
const messages: string[] = [];

interface SetupOptions {
  readonly sendFailure?: Error;
}

function setup(currentMajorMode = 'copilot', options: SetupOptions = {}) {
  const pi = {
    on: vi.fn(),
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn((content: string) => {
      messages.push(content);
      if (options.sendFailure) throw options.sendFailure;
    }),
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: { getSessionId: () => 'major-mode-voice-session' },
  } as unknown as ExtensionContext;
  const cordis = new Context();
  provideDoomConfigContext(cordis, {
    settings: { projectTrust: 'ask' },
    harness: { ...readHarnessState({}), majorMode: currentMajorMode, domains: ['default'] },
    requiresRelaunch: false,
  });
  disposeAll.push(() => void cordis.fiber.dispose());
  disposeAll.push(
    bindStubCoordinator(cordis, ctx.sessionManager.getSessionId(), {
      domains: ['default'],
      majorMode: currentMajorMode,
      layers: ['team'],
    }).dispose,
  );

  const voiceTools = createDoomVoiceToolsService<ExtensionContext>(`major-mode-test:${crypto.randomUUID()}`);
  const reloadHandoffs = createVoiceReloadHandoffStore({
    now: () => Date.now(),
    createToken: () => crypto.randomUUID(),
  });
  const session = voiceTools.bindSession('major-mode-voice-session', ctx);
  session.setActive(true);
  disposeAll.push(() => {
    session.dispose();
    voiceTools.dispose();
  });

  const view: MajorModeView = { config, majorMode: currentMajorMode, domains: ['default'] };
  const disposeCapability = registerMajorModeVoiceCapability(
    voiceTools,
    pi,
    async () => view,
    reloadHandoffs,
    () => cordis,
  );
  disposeAll.push(disposeCapability);

  const definition = session.describe().tools.find((tool) => tool.name === 'major_mode');
  const execute = async (input: unknown) => {
    const catalogToken = session.describe().catalogToken;
    const result = await session.executeBatch({ catalogToken, calls: [{ name: 'major_mode', input }] }, ctx, {
      operationId: `operation-${crypto.randomUUID()}`,
    });
    const item = result.results[0];
    if (item?.error) throw new Error(item.error.message);
    return item?.result;
  };
  return { definition, disposeCapability, execute, reloadHandoffs, session };
}

beforeEach(() => {
  vi.clearAllMocks();
  messages.length = 0;
});

afterEach(() => {
  for (const dispose of disposeAll.reverse()) dispose();
  disposeAll = [];
});

describe('major_mode voice tool', () => {
  it('registers under this package as its source', () => {
    const { definition } = setup();
    expect(definition?.name).toBe('major_mode');
  });

  it('withdraws the tool as soon as its contribution is disposed', () => {
    const { disposeCapability, session } = setup();

    disposeCapability();

    expect(session.describe().tools).toEqual([]);
  });

  it('lists every configured mode with its purpose and layers', async () => {
    const { execute } = setup();

    expect(await execute({ action: 'list' })).toEqual({
      status: 'listed',
      current: 'copilot',
      modes: [
        { name: 'minimal', description: 'Lean mode.', layers: ['team'] },
        { name: 'copilot', description: 'Full mode.', layers: ['team', 'plan'] },
      ],
    });
  });

  it('queues a switch as a follow-up command rather than applying it', async () => {
    const { execute } = setup();

    expect(await execute({ action: 'switch', majorMode: 'minimal' })).toEqual({
      status: 'queued',
      majorMode: 'minimal',
      stopBatch: 'session-reload',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('/mode --voice-switch-token=');
  });

  it('reports the mode unchanged instead of queueing a no-op reload', async () => {
    const { execute } = setup();

    expect(await execute({ action: 'switch', majorMode: 'copilot' })).toEqual({
      status: 'unchanged',
      majorMode: 'copilot',
    });
    expect(messages).toHaveLength(0);
  });

  it('rejects a mode the configuration does not declare', async () => {
    const { execute } = setup();

    await expect(execute({ action: 'switch', majorMode: 'ghost' })).rejects.toThrow('Voice tool execution failed.');
    expect(messages).toHaveLength(0);
  });

  it('discards its reload handoff when Pi rejects the follow-up message', async () => {
    const { execute, reloadHandoffs, session } = setup('copilot', {
      sendFailure: new Error('follow-up unavailable'),
    });

    await expect(execute({ action: 'switch', majorMode: 'minimal' })).rejects.toThrow('Voice tool execution failed.');
    const token = messages[0]?.match(/--voice-switch-token=([^\s]+)/u)?.[1];
    if (!token) throw new Error('the failed follow-up did not include a reload token');
    expect(
      reloadHandoffs.accept(token, {
        sessionId: session.sessionId,
        hostGeneration: session.hostGeneration,
      }),
    ).toBeUndefined();
  });
});
