import { DOOM_ASK_USER_BLOCKED_EVENT } from '@agimon-ai/doompi-core/ask-user';
import { DOOM_CORDIS_SESSION_SERVICE, type DoomCordisSessionService } from '@agimon-ai/doompi-core/cordis-host';
import { createNarrationRequest, readDoomNarrationService } from '@agimon-ai/doompi-core/narration';
import { createDoomToolSurface } from '@agimon-ai/doompi-core/tool-surface';
import { VOICE_MODE_TOOL_NAMES } from '@agimon-ai/doompi-core/voice-tools';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import type { NarrationToolRuntime } from '../src/controllers/narrationTool';
import {
  type AutoCapturePiEventController,
  createVoiceNarrationService,
  extractTerminalAssistantText,
  registerAutoCaptureCordisEventHandlers,
  registerSessionVoiceNarrationService,
  createVoiceTurnFallback,
  type VoiceTurnFallbackRuntime,
  voiceToolRestriction,
} from '../src/controllers/voice';
import { deliverAutoCaptureInput } from '../src/controllers/voice';
import { createDoomVoiceToolsService } from '../src/services/voiceTools';
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

describe('Voice-owned tool restriction', () => {
  function fixture(registered = [...VOICE_MODE_TOOL_NAMES]) {
    const all = ['read', 'write', ...registered];
    let activeTools = [...all];
    const surface = createDoomToolSurface({
      generation: 'voice-test',
      allTools: () => all,
      activeTools: () => activeTools,
      setActiveTools: (names) => {
        activeTools = [...names];
      },
    });
    const handle = surface.register({ source: 'voice', restrict: voiceToolRestriction(false) });
    return { handle, visible: () => surface.active() };
  }

  it('hides every Voice-owned tool until autonomous voice is on', () => {
    const h = fixture();
    expect(h.visible()).toEqual(['read', 'write']);
    h.handle.update(voiceToolRestriction(true));
    expect(h.visible()).toEqual(['read', 'write', ...VOICE_MODE_TOOL_NAMES]);
  });

  it('shows the facade only when every Voice-owned tool reached the host', () => {
    const incomplete = fixture(['describe_voice_tools', 'use_voice_tools']);
    incomplete.handle.update(voiceToolRestriction(true));
    expect(incomplete.visible()).toEqual(['read', 'write']);
  });

  it('keeps narrate hidden while live mode owns narration', () => {
    const live = fixture();
    live.handle.update(voiceToolRestriction(true, false));
    expect(live.visible()).toContain('use_voice_tools');
    expect(live.visible()).not.toContain('narrate');
  });
});

describe('Doom Voice Cordis wiring', () => {
  function narrationContext(sessionId: string): ExtensionContext {
    return {
      hasUI: true,
      sessionManager: { getSessionId: () => sessionId },
      signal: undefined,
    } as unknown as ExtensionContext;
  }

  function runtimeFixture(sessionId: string, context: ExtensionContext, active = true) {
    const voiceTools = createDoomVoiceToolsService<ExtensionContext>(`voice-narration-test:${sessionId}`);
    const session = voiceTools.bindSession(sessionId, context);
    session.setActive(active);
    const runtime: NarrationToolRuntime = {
      context,
      session,
      controller: { state: active ? 'active' : 'disabled', narrateAgent: vi.fn(async () => 'completed' as const) },
    };
    return { runtime, dispose: () => voiceTools.dispose() };
  }

  function mountSession(cordis: Context, sessionId: string, generation: string, context: ExtensionContext) {
    const service: DoomCordisSessionService = Object.freeze({
      sessionId,
      generation,
      reason: 'startup',
      context,
    });
    return cordis.plugin((sessionContext) => sessionContext.provide(DOOM_CORDIS_SESSION_SERVICE, service));
  }

  function request(text: string) {
    const value = createNarrationRequest(text);
    if (!value) throw new Error('Expected a narration request.');
    return value;
  }

  it('publishes a direct narration service for caller-owned speech', async () => {
    const controller = { narrateExternal: vi.fn(async () => 'completed' as const) };
    const sessionAbort = new AbortController();
    const service = createVoiceNarrationService(controller, {
      generation: 'voice-session:narration',
      signal: sessionAbort.signal,
      isCurrentSession: () => true,
    });
    await service.request(request('Caller-owned narration.'));

    expect(service.generation).toBe('voice-session:narration');
    expect(controller.narrateExternal).toHaveBeenCalledOnce();
    expect(controller.narrateExternal).toHaveBeenCalledWith('Caller-owned narration.', sessionAbort.signal);
  });

  it('reports rejected external playback to the direct caller', async () => {
    const controller = { narrateExternal: vi.fn(async () => Promise.reject(new Error('speaker unavailable'))) };
    const sessionAbort = new AbortController();
    const service = createVoiceNarrationService(controller, {
      generation: 'voice-session:narration',
      signal: sessionAbort.signal,
      isCurrentSession: () => true,
    });
    await expect(service.request(request('Status.'))).rejects.toThrow('speaker unavailable');
    expect(controller.narrateExternal).toHaveBeenCalledOnce();
  });

  it('provides external narration only for the exact active Cordis session', async () => {
    const cordis = new Context();
    const controller = {
      narrateExternal: vi.fn(async (_text: string, _signal?: AbortSignal) => 'completed' as const),
    };
    let runtime: NarrationToolRuntime | undefined;
    registerSessionVoiceNarrationService(cordis, controller, () => runtime);
    expect(readDoomNarrationService(cordis)).toBeUndefined();

    const contextA = narrationContext('session-a');
    const activeA = runtimeFixture('session-a', contextA);
    runtime = activeA.runtime;
    const sessionA = mountSession(cordis, 'session-a', 'cordis-session-a', contextA);
    await sessionA.await();
    const serviceA = readDoomNarrationService(cordis);
    if (!serviceA) throw new Error('Expected session A narration service.');
    expect(serviceA.generation).toBe('cordis-session-a:voice-narration');
    await serviceA.request(request('Session A update.'));
    expect(controller.narrateExternal).toHaveBeenCalledOnce();
    const signalA = controller.narrateExternal.mock.calls[0]?.[1];

    await sessionA.dispose();
    expect(readDoomNarrationService(cordis)).toBeUndefined();
    await serviceA.request(request('Stale session A update.'));
    expect(controller.narrateExternal).toHaveBeenCalledOnce();
    expect(signalA?.aborted).toBe(true);

    const contextB = narrationContext('session-b');
    const sessionB = mountSession(cordis, 'session-b', 'cordis-session-b', contextB);
    await sessionB.await();
    const serviceB = readDoomNarrationService(cordis);
    if (!serviceB) throw new Error('Expected session B narration service.');
    await serviceB.request(request('Mismatched session B update.'));
    expect(controller.narrateExternal).toHaveBeenCalledOnce();

    const activeB = runtimeFixture('session-b', contextB);
    runtime = activeB.runtime;
    await serviceB.request(request('Session B update.'));
    expect(controller.narrateExternal).toHaveBeenCalledTimes(2);
    const signalB = controller.narrateExternal.mock.calls[1]?.[1];
    expect(signalB).not.toBe(signalA);

    await sessionB.dispose();
    activeA.dispose();
    activeB.dispose();
    await cordis.fiber.dispose();
  });

  it('aborts in-flight external narration when its Cordis session is disposed', async () => {
    const cordis = new Context();
    let narrationSignal: AbortSignal | undefined;
    const controller = {
      narrateExternal: vi.fn(
        async (_text: string, signal?: AbortSignal) =>
          new Promise<'interrupted'>((resolve) => {
            narrationSignal = signal;
            signal?.addEventListener('abort', () => resolve('interrupted'), { once: true });
          }),
      ),
    };
    let runtime: NarrationToolRuntime | undefined;
    registerSessionVoiceNarrationService(cordis, controller, () => runtime);
    const context = narrationContext('session-active');
    const active = runtimeFixture('session-active', context);
    runtime = active.runtime;
    const session = mountSession(cordis, 'session-active', 'cordis-session-active', context);
    await session.await();
    const service = readDoomNarrationService(cordis);
    if (!service) throw new Error('Expected active narration service.');

    const pending = service.request(request('In-flight update.'));
    await vi.waitFor(() => expect(narrationSignal).toBeDefined());
    await session.dispose();

    await expect(pending).resolves.toBeUndefined();
    expect(narrationSignal?.aborted).toBe(true);
    active.dispose();
    await cordis.fiber.dispose();
  });

  it('keeps an active background root independent from an inactive root', async () => {
    const rootA = new Context();
    const rootB = new Context();
    const controllerA = { narrateExternal: vi.fn(async () => 'completed' as const) };
    const controllerB = { narrateExternal: vi.fn(async () => 'completed' as const) };
    const contextA = narrationContext('background-a');
    const contextB = narrationContext('inactive-b');
    const activeA = runtimeFixture('background-a', contextA);
    const inactiveB = runtimeFixture('inactive-b', contextB, false);
    registerSessionVoiceNarrationService(rootA, controllerA, () => activeA.runtime);
    registerSessionVoiceNarrationService(rootB, controllerB, () => inactiveB.runtime);
    const sessionA = mountSession(rootA, 'background-a', 'cordis-background-a', contextA);
    const sessionB = mountSession(rootB, 'inactive-b', 'cordis-inactive-b', contextB);
    await Promise.all([sessionA.await(), sessionB.await()]);
    const serviceA = readDoomNarrationService(rootA);
    const serviceB = readDoomNarrationService(rootB);
    if (!serviceA || !serviceB) throw new Error('Expected both session narration services.');

    await serviceA.request(request('Background A update.'));
    await serviceB.request(request('Inactive B update.'));
    await serviceA.request(request('Background A continues.'));

    expect(controllerA.narrateExternal).toHaveBeenCalledTimes(2);
    expect(controllerB.narrateExternal).not.toHaveBeenCalled();
    await Promise.all([sessionA.dispose(), sessionB.dispose()]);
    activeA.dispose();
    inactiveB.dispose();
    await Promise.all([rootA.fiber.dispose(), rootB.fiber.dispose()]);
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
    const fallback = createVoiceTurnFallback(runtime);
    for (const [name, handler] of Object.entries(fallback.events)) handlers.set(name, handler as LifecycleHandler);
    const dispose = () => fallback.dispose();
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
