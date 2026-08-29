import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TRANSFER_VOICE_TOOL_NAME,
  createTransferVoiceToolLifecycle,
  reconcileTransferVoiceTool,
  registerTransferVoiceTool,
} from '../src/adapters/pi/transferVoiceTool.ts';
import { sessionVoiceOwnership } from '../src/services/sessionVoiceOwnership.ts';
import { VOICE_OWNERSHIP_PROTOCOL_VERSION, type VoiceOwnershipCommand } from '../src/types/voiceOwnership.ts';

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
    const registration = registerTransferVoiceTool({ registerTool: registerTool as never });
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

    registration.refresh();
    expect(registerTool).toHaveBeenCalledOnce();
    await sessionVoiceOwnership.command({
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      commandId: 'catalog-tool-2',
      action: 'catalog',
      targets: [{ handle: 'target-2', label: 'Second', order: 1 }],
    });
    registration.refresh();
    expect(registerTool).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('reconciles visibility from active server ownership', async () => {
    const state = { value: 'active' as const } as { value: 'active' | 'disabled' };
    const dispose = await installOwner(state);
    let activeTools = ['read'];
    const setActiveTools = vi.fn((tools: string[]) => {
      activeTools = tools;
    });
    const pi = { getActiveTools: () => activeTools, setActiveTools };

    reconcileTransferVoiceTool(pi);
    expect(activeTools).toEqual(['read', TRANSFER_VOICE_TOOL_NAME]);
    reconcileTransferVoiceTool(pi);
    expect(setActiveTools).toHaveBeenCalledOnce();

    state.value = 'disabled';
    reconcileTransferVoiceTool(pi);
    expect(activeTools).toEqual(['read']);
    dispose();
  });

  it('refreshes and disposes its session lifecycle timer', async () => {
    vi.useFakeTimers();
    const state = { value: 'active' as const } as { value: 'active' | 'disabled' };
    const dispose = await installOwner(state);
    let activeTools: string[] = [];
    const lifecycle = createTransferVoiceToolLifecycle({
      registerTool: vi.fn() as never,
      getActiveTools: () => activeTools,
      setActiveTools: (tools) => {
        activeTools = tools;
      },
    });

    lifecycle.sessionStarted();
    lifecycle.sessionStarted();
    expect(activeTools).toContain(TRANSFER_VOICE_TOOL_NAME);
    lifecycle.dispose();
    lifecycle.dispose();
    dispose();
  });
});
