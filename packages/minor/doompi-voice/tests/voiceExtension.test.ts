import { DOOM_ASK_USER_BLOCKED_EVENT } from '@agimon-ai/doompi-extension-contracts/ask-user';
import { createNarrationRequest } from '@agimon-ai/doompi-extension-contracts/narration';
import { VOICE_MODE_TOOL_NAMES } from '@agimon-ai/doompi-extension-contracts/voice-tools';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  type AutoCapturePiEventController,
  createVoiceNarrationService,
  extractTerminalAssistantText,
  reconcileVoiceModeTools,
  registerAutoCaptureCordisEventHandlers,
  registerVoiceTurnFallback,
  type VoiceTurnFallbackRuntime,
} from '../src/exports';
import { deliverAutoCaptureInput } from '../src/adapters/pi/voice.ts';
describe('autonomous prompt delivery', () => {
  it('queues composed prompts as follow-ups without changing ordinary idle or steer delivery', () => {
    const sendUserMessage = vi.fn();
    const pi = { sendUserMessage } as unknown as Pick<ExtensionAPI, 'sendUserMessage'>;
    const idle = { isIdle: () => true } as Pick<ExtensionContext, 'isIdle'>;
    const busy = { isIdle: () => false } as Pick<ExtensionContext, 'isIdle'>;

    deliverAutoCaptureInput(pi, idle, 'idle prompt');
    deliverAutoCaptureInput(pi, busy, 'busy prompt');
    deliverAutoCaptureInput(pi, idle, 'idle composition', 'queuedFollowUp');
    deliverAutoCaptureInput(pi, busy, 'busy composition', 'queuedFollowUp');

    expect(sendUserMessage).toHaveBeenNthCalledWith(1, 'idle prompt');
    expect(sendUserMessage).toHaveBeenNthCalledWith(2, 'busy prompt', { deliverAs: 'steer' });
    expect(sendUserMessage).toHaveBeenNthCalledWith(3, 'idle composition', { deliverAs: 'followUp' });
    expect(sendUserMessage).toHaveBeenNthCalledWith(4, 'busy composition', { deliverAs: 'followUp' });
  });
});

describe('Voice-owned tool reconciliation', () => {
  function fixture(registered = [...VOICE_MODE_TOOL_NAMES]) {
    let active = ['read', ...VOICE_MODE_TOOL_NAMES, 'write'];
    const setActiveTools = vi.fn((names: string[]) => {
      active = [...names];
    });
    const pi = {
      getActiveTools: () => [...active],
      getAllTools: () => ['read', 'write', ...registered].map((name) => ({ name })),
      setActiveTools,
    } as unknown as ExtensionAPI;
    return { pi, active: () => [...active], setActiveTools };
  }

  it('removes every stale Voice-owned name while preserving unrelated tool order', () => {
    const h = fixture();
    reconcileVoiceModeTools(h.pi, false);
    expect(h.active()).toEqual(['read', 'write']);
  });

  it('re-adds all three names only when every Voice-owned tool is registered', () => {
    const enabled = fixture();
    reconcileVoiceModeTools(enabled.pi, false);
    reconcileVoiceModeTools(enabled.pi, true);
    expect(enabled.active()).toEqual(['read', 'write', ...VOICE_MODE_TOOL_NAMES]);

    const incomplete = fixture(['describe_voice_tools', 'use_voice_tools']);
    reconcileVoiceModeTools(incomplete.pi, true);
    expect(incomplete.active()).toEqual(['read', 'write']);
    expect(incomplete.active()).not.toContain('narrate');
  });
});

describe('Doom Voice Cordis wiring', () => {
  it('publishes a direct narration service for caller-owned speech', async () => {
    const controller = { narrateExternal: vi.fn(async () => 'completed' as const) };
    const service = createVoiceNarrationService(controller);
    const request = createNarrationRequest('Caller-owned narration.');
    if (!request) throw new Error('Expected a narration request.');
    await service.request(request);

    expect(controller.narrateExternal).toHaveBeenCalledOnce();
    expect(controller.narrateExternal).toHaveBeenCalledWith('Caller-owned narration.');
  });

  it('reports rejected external playback to the direct caller', async () => {
    const controller = { narrateExternal: vi.fn(async () => Promise.reject(new Error('speaker unavailable'))) };
    const service = createVoiceNarrationService(controller);
    const request = createNarrationRequest('Status.');
    if (!request) throw new Error('Expected a narration request.');
    await expect(service.request(request)).rejects.toThrow('speaker unavailable');
    expect(controller.narrateExternal).toHaveBeenCalledOnce();
  });

  it('subscribes only while the Cordis event consumer is live', async () => {
    const cordis = new Context();
    const controller: AutoCapturePiEventController = { askUserBlocked: vi.fn() };
    const dispose = registerAutoCaptureCordisEventHandlers(cordis, controller);
    cordis.emit(DOOM_ASK_USER_BLOCKED_EVENT, { active: true });
    cordis.emit(DOOM_ASK_USER_BLOCKED_EVENT, { active: false });
    expect(controller.askUserBlocked).toHaveBeenNthCalledWith(1, true);
    expect(controller.askUserBlocked).toHaveBeenNthCalledWith(2, false);
    dispose();
    cordis.emit(DOOM_ASK_USER_BLOCKED_EVENT, { active: true });
    expect(controller.askUserBlocked).toHaveBeenCalledTimes(2);
    await cordis.fiber.dispose();
  });
});

describe('turn-end narration fallback', () => {
  type LifecycleHandler = (event: unknown, context: ExtensionContext) => unknown;

  function context(sessionId: string, sessionManager?: object): ExtensionContext {
    const manager =
      sessionManager ??
      ({
        getSessionId: () => sessionId,
      } as const);
    return {
      sessionManager: manager,
      signal: undefined,
    } as unknown as ExtensionContext;
  }

  function terminalMessage(text: string): unknown {
    return { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] };
  }

  function fallbackHarness() {
    const handlers = new Map<string, LifecycleHandler>();
    let generation: number | undefined = 7;
    const runtime: VoiceTurnFallbackRuntime = {
      activeGeneration: vi.fn(() => generation),
      narrate: vi.fn(async () => 'completed' as const),
    };
    const dispose = registerVoiceTurnFallback(
      {
        on: ((name: string, handler: LifecycleHandler) => {
          handlers.set(name, handler);
        }) as ExtensionAPI['on'],
      },
      runtime,
    );
    return {
      runtime,
      dispose,
      fire: (name: string, event: unknown, eventContext: ExtensionContext) => handlers.get(name)?.(event, eventContext),
      setGeneration(value: number | undefined) {
        generation = value;
      },
    };
  }

  it('speaks the terminal assistant response only when no narrate call occurred', async () => {
    const h = fallbackHarness();
    const ctx = context('session-1');

    h.fire('before_agent_start', {}, ctx);
    h.fire('tool_execution_start', { toolName: 'read' }, ctx);
    h.fire('turn_end', { message: terminalMessage('Short final answer.') }, ctx);
    await h.fire('agent_settled', {}, ctx);

    expect(h.runtime.narrate).toHaveBeenCalledOnce();
    expect(h.runtime.narrate).toHaveBeenCalledWith('Short final answer.', undefined);
  });

  it('suppresses fallback after any direct narrate attempt', async () => {
    const h = fallbackHarness();
    const ctx = context('session-1');

    h.fire('before_agent_start', {}, ctx);
    h.fire('tool_execution_start', { toolName: 'narrate' }, ctx);
    h.fire('turn_end', { message: terminalMessage('Already narrated.') }, ctx);
    await h.fire('agent_settled', {}, ctx);

    expect(h.runtime.narrate).not.toHaveBeenCalled();
  });

  it('fails closed across inactive, replaced, and non-terminal turns', async () => {
    const inactive = fallbackHarness();
    const ctx = context('session-1');
    inactive.setGeneration(undefined);
    inactive.fire('before_agent_start', {}, ctx);
    inactive.fire('turn_end', { message: terminalMessage('Silent.') }, ctx);
    await inactive.fire('agent_settled', {}, ctx);
    expect(inactive.runtime.narrate).not.toHaveBeenCalled();

    const replaced = fallbackHarness();
    replaced.fire('before_agent_start', {}, ctx);
    replaced.fire('turn_end', { message: terminalMessage('Stale.') }, ctx);
    replaced.setGeneration(8);
    await replaced.fire('agent_settled', {}, ctx);
    expect(replaced.runtime.narrate).not.toHaveBeenCalled();

    const replacedSession = fallbackHarness();
    replacedSession.fire('before_agent_start', {}, ctx);
    replacedSession.fire('turn_end', { message: terminalMessage('Cross-session stale.') }, ctx);
    await replacedSession.fire('agent_settled', {}, context('session-2'));
    expect(replacedSession.runtime.narrate).not.toHaveBeenCalled();

    const toolTurn = fallbackHarness();
    toolTurn.fire('before_agent_start', {}, ctx);
    toolTurn.fire(
      'turn_end',
      { message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'Working.' }] } },
      ctx,
    );
    await toolTurn.fire('agent_settled', {}, ctx);
    expect(toolTurn.runtime.narrate).not.toHaveBeenCalled();

    const disposed = fallbackHarness();
    disposed.fire('before_agent_start', {}, ctx);
    disposed.fire('turn_end', { message: terminalMessage('Stale after reload.') }, ctx);
    disposed.dispose();
    await disposed.fire('agent_settled', {}, ctx);
    expect(disposed.runtime.narrate).not.toHaveBeenCalled();
  });

  it('extracts only terminal assistant text without tool calls', () => {
    expect(extractTerminalAssistantText(terminalMessage(' Ready. '))).toBe('Ready.');
    expect(
      extractTerminalAssistantText({
        role: 'assistant',
        stopReason: 'stop',
        content: [
          { type: 'text', text: 'partial' },
          { type: 'toolCall', name: 'read' },
        ],
      }),
    ).toBeUndefined();
    expect(
      extractTerminalAssistantText({ role: 'user', content: [{ type: 'text', text: 'ignored' }] }),
    ).toBeUndefined();
  });
});
