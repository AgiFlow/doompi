import { createNarrationRequest } from '@agimon-ai/doompi-core/narration';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import {
  createVoiceNarrationService,
  createVoiceTurnFallback,
  extractTerminalAssistantText,
  resolveVoiceCommandCorrector,
  resolveVoiceFallbackNarrator,
  resolveVoiceTranscriptAdjudicator,
} from '../src/services/voice';

function modelContext(options: {
  found?: boolean;
  authenticated?: boolean;
  response?: { stopReason: string; errorMessage?: string; content: Array<{ type: string; text?: string }> };
}) {
  const complete = vi.fn(
    async () => options.response ?? { stopReason: 'stop', content: [{ type: 'text', text: '{"corrections":[]}' }] },
  );
  return {
    context: {
      modelRegistry: {
        find: () => (options.found === false ? undefined : { provider: 'provider', id: 'model', api: 'test' }),
        hasConfiguredAuth: () => options.authenticated !== false,
        complete,
      },
    } as unknown as ExtensionContext,
    complete,
  };
}

describe('extracted voice service boundaries', () => {
  it('rejects invalid or stale narration requests before playback', async () => {
    const narrateExternal = vi.fn(async () => 'completed' as const);
    const controller = { narrateExternal };
    const current = createVoiceNarrationService(controller, {
      generation: 'current',
      signal: new AbortController().signal,
      isCurrentSession: () => true,
    });
    await expect(current.request(null as never)).rejects.toThrow('Invalid narration request');

    const aborted = new AbortController();
    aborted.abort();
    const stale = createVoiceNarrationService(controller, {
      generation: 'stale',
      signal: aborted.signal,
      isCurrentSession: () => false,
    });
    const request = createNarrationRequest('Do not play stale narration.');
    if (!request) throw new Error('Expected a valid narration request.');
    await stale.request(request);
    expect(narrateExternal).not.toHaveBeenCalled();
  });

  it('extracts text only from terminal assistant messages', () => {
    expect(extractTerminalAssistantText(null)).toBeUndefined();
    expect(extractTerminalAssistantText([])).toBeUndefined();
    expect(extractTerminalAssistantText({ role: 'assistant', stopReason: 'stop', content: 'text' })).toBeUndefined();
    expect(
      extractTerminalAssistantText({
        role: 'assistant',
        stopReason: 'stop',
        content: [null, { type: 'image' }, { type: 'text', text: 4 }, { type: 'text', text: '  ' }],
      }),
    ).toBeUndefined();
    expect(
      extractTerminalAssistantText({
        role: 'assistant',
        stopReason: 'stop',
        content: [
          { type: 'text', text: 'first ' },
          { type: 'text', text: 'second' },
        ],
      }),
    ).toBe('first second');
  });

  it('ignores fallback lifecycle events after disposal and across session managers', async () => {
    const narrate = vi.fn(async () => 'completed' as const);
    const runtime = { activeGeneration: vi.fn(() => 3), narrate };
    const fallback = createVoiceTurnFallback(runtime);
    const managerA = { getSessionId: () => 'same-id' };
    const managerB = { getSessionId: () => 'same-id' };
    const contextA = { sessionManager: managerA } as unknown as ExtensionContext;
    const contextB = { sessionManager: managerB } as unknown as ExtensionContext;

    await fallback.events.agent_start?.({ runId: 'run-voice-boundary' } as never, contextA);
    await fallback.events.tool_execution_start?.({ toolName: 'narrate' } as never, contextB);
    await fallback.events.turn_end?.(
      {
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Must not cross session manager boundaries.' }],
        },
      } as never,
      contextB,
    );
    await fallback.events.agent_settled?.({} as never, contextA);
    expect(narrate).not.toHaveBeenCalled();

    fallback.dispose();
    await fallback.events.agent_start?.({ runId: 'run-late' } as never, contextA);
    await fallback.events.tool_execution_start?.({ toolName: 'narrate' } as never, contextA);
    await fallback.events.turn_end?.({ message: {} } as never, contextA);
    await fallback.events.agent_settled?.({} as never, contextA);
    expect(runtime.activeGeneration).toHaveBeenCalledOnce();
  });

  it.each([
    ['command correction', resolveVoiceCommandCorrector, 'Voice command correction model'],
    [
      'transcript admission',
      (reference: string, context: ExtensionContext) =>
        resolveVoiceTranscriptAdjudicator(reference, context, { now: () => 0 } as never),
      'Voice transcript admission model',
    ],
    ['fallback narration', resolveVoiceFallbackNarrator, 'Voice fallback narration model'],
  ])('validates the %s model reference and registry state', (_name, resolve, label) => {
    expect(() => resolve('invalid', modelContext({}).context)).toThrow(`${label} must use provider/model-id form`);
    expect(() => resolve('/model', modelContext({}).context)).toThrow(`${label} must use provider/model-id form`);
    expect(() => resolve('provider/', modelContext({}).context)).toThrow(`${label} must use provider/model-id form`);
    expect(() => resolve('provider/model', modelContext({ found: false }).context)).toThrow(
      `${label} is not registered`,
    );
    expect(() => resolve('provider/model', modelContext({ authenticated: false }).context)).toThrow(
      `${label} has no configured authentication`,
    );
  });

  it('propagates model stop failures without leaking non-text response content', async () => {
    const failed = modelContext({
      response: { stopReason: 'error', errorMessage: 'model bridge failed', content: [] },
    });
    const corrector = resolveVoiceCommandCorrector('provider/model', failed.context);
    await expect(
      corrector.correct(
        { transcript: 'open doom pie', context: { tasks: ['Open DoomPi'] } },
        new AbortController().signal,
      ),
    ).rejects.toThrow('model bridge failed');

    const aborted = modelContext({ response: { stopReason: 'aborted', content: [{ type: 'image' }] } });
    const narrator = resolveVoiceFallbackNarrator('provider/model', aborted.context);
    const result = await narrator.create('Long final response. '.repeat(40), new AbortController().signal);
    expect(result.source).toBe('model-fallback');
    expect(result.generationError).toEqual(new Error('Voice fallback narration model stopped with aborted'));
  });
});
