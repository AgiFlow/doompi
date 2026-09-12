import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { definePiExtension } from '@agimon-ai/doompi-extension-contracts/pi-extension';
import { createDoomToolSurface } from '@agimon-ai/doompi-extension-contracts/tool-surface';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TRANSFER_VOICE_TOOL_NAME,
  createTransferVoiceToolLifecycle,
  transferVoiceToolRestriction,
  transferVoiceToolVisible,
} from '../src/controllers/transferVoiceTool';
import { sessionVoiceOwnership } from '../src/services/sessionVoiceOwnership';
import { VOICE_OWNERSHIP_PROTOCOL_VERSION, type VoiceOwnershipCommand } from '../src/types/voiceOwnership';

function surfaceFixture() {
  const all = ['read', TRANSFER_VOICE_TOOL_NAME];
  let activeTools = [...all];
  const surface = createDoomToolSurface({
    generation: 'transfer-voice-test',
    allTools: () => all,
    activeTools: () => activeTools,
    setActiveTools: (names) => {
      activeTools = [...names];
    },
  });
  const handle = surface.register({
    source: 'voice#transfer-voice',
    restrict: transferVoiceToolRestriction(transferVoiceToolVisible()),
  });
  return { handle, visible: () => surface.active() };
}

afterEach(() => {
  vi.useRealTimers();
});

async function installOwner(state: { value: 'active' | 'disabled' }) {
  const dispose = sessionVoiceOwnership.register({
    label: 'Source',
    eligible: true,
    controller: {
      get state() {
        return state.value;
      },
      activateVoice: async () => {
        state.value = 'active';
      },
      deactivateVoice: async () => {
        state.value = 'disabled';
      },
    },
  });
  const catalog: VoiceOwnershipCommand = {
    version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
    commandId: 'catalog-tool',
    action: 'catalog',
    targets: [{ handle: 'target-handle', label: 'Target', order: 1 }],
  };
  await sessionVoiceOwnership.command(catalog);
  return dispose;
}

describe('transfer_voice server handoff tool', () => {
  it('lists numbered targets and requests a server-side handoff', async () => {
    const state = { value: 'active' as const } as { value: 'active' | 'disabled' };
    const dispose = await installOwner(state);
    const registerTool = vi.fn();
    const registration = createTransferVoiceToolLifecycle(() => undefined);
    const root = new Context();
    await definePiExtension({ name: 'transfer-test', tools: registration }).install(root, {
      registerTool,
      on: vi.fn(),
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI);
    const tool = registerTool.mock.calls[0]![0] as {
      description: string;
      execute(
        ...args: unknown[]
      ): Promise<{ content: Array<{ type: string; text: string }>; details: { accepted: boolean } }>;
    };

    expect(tool.description).toContain('1. Target');
    await expect(tool.execute('call', { target: '1' })).resolves.toMatchObject({ details: { accepted: false } });
    await expect(tool.execute('call', { target: 2 })).resolves.toMatchObject({ details: { accepted: false } });
    const accepted = await tool.execute('call', { target: 1 });
    expect(accepted.details.accepted).toBe(true);
    expect(accepted.content[0]?.text).toContain('Target');
    expect(sessionVoiceOwnership.snapshot().handoff).toMatchObject({ handle: 'target-handle' });

    registration.sessionStarted();
    expect(registerTool).toHaveBeenCalledOnce();
    await sessionVoiceOwnership.command({
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      commandId: 'catalog-tool-2',
      action: 'catalog',
      targets: [{ handle: 'target-2', label: 'Second', order: 1 }],
    });
    registration.sessionStarted();
    expect(registerTool).toHaveBeenCalledTimes(2);
    registration.dispose();
    await root.fiber.dispose();
    dispose();
  });

  it('shows the tool only while the server holds ownership with a listed target', async () => {
    const state = { value: 'active' as const } as { value: 'active' | 'disabled' };
    const dispose = await installOwner(state);
    const surface = surfaceFixture();

    surface.handle.update(transferVoiceToolRestriction(transferVoiceToolVisible()));
    expect(surface.visible()).toEqual(['read', TRANSFER_VOICE_TOOL_NAME]);

    state.value = 'disabled';
    surface.handle.update(transferVoiceToolRestriction(transferVoiceToolVisible()));
    expect(surface.visible()).toEqual(['read']);
    dispose();
  });

  it('refreshes and disposes its session lifecycle timer', async () => {
    vi.useFakeTimers();
    const state = { value: 'active' as const } as { value: 'active' | 'disabled' };
    const dispose = await installOwner(state);
    const surface = surfaceFixture();
    const lifecycle = createTransferVoiceToolLifecycle((restrict) => surface.handle.update(restrict));

    lifecycle.sessionStarted();
    lifecycle.sessionStarted();
    expect(surface.visible()).toContain(TRANSFER_VOICE_TOOL_NAME);

    state.value = 'disabled';
    vi.advanceTimersByTime(1_000);
    expect(surface.visible()).not.toContain(TRANSFER_VOICE_TOOL_NAME);
    lifecycle.dispose();
    lifecycle.dispose();
    dispose();
  });
});
