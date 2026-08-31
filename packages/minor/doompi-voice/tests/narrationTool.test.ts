import {
  createDoomVoiceToolsService,
  VOICE_FACADE_TOOL_NAMES,
  VOICE_MODE_TOOL_NAMES,
  VOICE_NARRATE_TOOL_NAME,
} from '@agimon-ai/doompi-extension-contracts/voice-tools';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  createNarrationTool,
  type NarrationToolOutcome,
  type NarrationToolRuntime,
} from '../src/adapters/pi/narrationTool.ts';

const NARRATION_OUTCOMES: readonly NarrationToolOutcome[] = ['completed', 'interrupted', 'superseded', 'failed'];

function context(
  sessionId: string,
  hasUI = true,
  mode: ExtensionContext['mode'] = hasUI ? 'tui' : 'print',
): ExtensionContext {
  return {
    hasUI,
    mode,
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function fixture(mode: ExtensionContext['mode'] = 'tui') {
  const boundContext = context('session-1', true, mode);
  const voiceTools = createDoomVoiceToolsService<ExtensionContext>(`narration-test:${crypto.randomUUID()}`);
  const session = voiceTools.bindSession('session-1', boundContext);
  session.setActive(true);
  const narrateAgent = vi.fn(
    async (_text: string, _signal?: AbortSignal): Promise<NarrationToolOutcome> => 'completed',
  );
  const controller = { state: 'active' as const, narrateAgent };
  let runtime: NarrationToolRuntime | undefined = { context: boundContext, session, controller };
  const tool = createNarrationTool(() => runtime);
  return {
    tool,
    boundContext,
    session,
    voiceTools,
    controller,
    narrateAgent,
    setRuntime(next: NarrationToolRuntime | undefined) {
      runtime = next;
    },
  };
}

describe('narrate Pi tool', () => {
  it('is standalone from the two façade names and carries primary-agent guidance', () => {
    const h = fixture();

    expect(VOICE_FACADE_TOOL_NAMES).toEqual(['describe_voice_tools', 'use_voice_tools']);
    expect(VOICE_FACADE_TOOL_NAMES).not.toContain(VOICE_NARRATE_TOOL_NAME);
    expect(VOICE_MODE_TOOL_NAMES).toEqual(['describe_voice_tools', 'use_voice_tools', 'narrate']);
    expect(h.tool).toMatchObject({
      name: 'narrate',
      label: 'Narrate',
      executionMode: 'sequential',
      renderShell: 'self',
      renderCall: expect.any(Function),
      renderResult: expect.any(Function),
    });
    expect(h.tool.description).toContain('active autonomous Voice session');
    expect(h.tool.description).toContain('physical playback settles');
    expect(h.tool.description).toContain('one concise primary-agent-authored update');
    expect(h.tool.description).not.toContain('complete answer');
    expect(h.tool.promptSnippet).toBeUndefined();
    expect(h.tool.promptGuidelines?.join('\n')).toContain('acknowledge the request');
    expect(h.tool.promptGuidelines?.join('\n')).toContain('before using tools or starting the work');
    expect(h.tool.promptGuidelines?.join('\n')).toContain(
      'meaningful finding, blocker, risk, or change in plan or direction',
    );
    expect(h.tool.promptGuidelines?.join('\n')).toContain('why it matters and what you will do next');
    expect(h.tool.promptGuidelines?.join('\n')).toContain('same update more than once');
    expect(h.tool.promptGuidelines?.join('\n')).toContain(
      'short conversational, clarification, refusal, or error turn',
    );
    expect(h.tool.promptGuidelines?.join('\n')).toContain('Only a narrate call produces speech');
    expect(h.tool.promptGuidelines?.join('\n')).toContain('one complete utterance');
    expect(h.tool.promptGuidelines?.join('\n')).toContain('concise, action-focused summary');
    expect(h.tool.promptGuidelines?.join('\n')).toContain('leave supporting detail in text');
    expect(h.tool.promptGuidelines?.join('\n')).toContain('4,096-character limit');
    expect(h.tool.promptGuidelines?.join('\n')).toContain('Avoid Markdown, code, secrets, and raw paths');

    h.session.dispose();
    h.voiceTools.dispose();
  });

  it('forwards exact text and the tool AbortSignal, then awaits physical settlement', async () => {
    const h = fixture();
    const completion = deferred<NarrationToolOutcome>();
    h.narrateAgent.mockImplementationOnce(async () => completion.promise);
    const controller = new AbortController();
    const onUpdate = vi.fn();

    const result = h.tool.execute(
      'narrate-1',
      { text: 'Exact primary-agent wording.' },
      controller.signal,
      onUpdate,
      h.boundContext,
    );
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(h.narrateAgent).toHaveBeenCalledWith('Exact primary-agent wording.', controller.signal);
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ details: { outcome: 'playing' } }));

    completion.resolve('completed');
    await expect(result).resolves.toMatchObject({ details: { outcome: 'completed' } });
    h.session.dispose();
    h.voiceTools.dispose();
  });

  it.each(NARRATION_OUTCOMES)('returns the structured %s outcome', async (outcome) => {
    const h = fixture();
    h.narrateAgent.mockResolvedValueOnce(outcome);

    const result = await h.tool.execute(
      'narrate-outcome',
      { text: 'One utterance.' },
      undefined,
      undefined,
      h.boundContext,
    );

    expect(result.details).toEqual({ outcome });
    h.session.dispose();
    h.voiceTools.dispose();
  });

  it('narrates from a cockpit session, which speaks over the same local audio device', async () => {
    const h = fixture('rpc');

    await expect(
      h.tool.execute('cockpit', { text: 'Spoken from the web.' }, undefined, undefined, h.boundContext),
    ).resolves.toMatchObject({ details: { outcome: 'completed' } });
    expect(h.narrateAgent).toHaveBeenCalledWith('Spoken from the web.', undefined);

    h.session.dispose();
    h.voiceTools.dispose();
  });

  it('rejects inactive, headless, stale, and mismatched sessions without playback', async () => {
    for (const state of ['disabled', 'starting', 'draining', 'shuttingDown'] as const) {
      const inactive = fixture();
      inactive.controller.state = state as never;
      await expect(
        inactive.tool.execute(`inactive-${state}`, { text: 'Ignored.' }, undefined, undefined, inactive.boundContext),
      ).resolves.toMatchObject({ details: { outcome: 'failed', error: { code: 'VOICE_TOOL_INACTIVE' } } });
      inactive.session.dispose();
      inactive.voiceTools.dispose();
    }

    const headless = fixture();
    await expect(
      headless.tool.execute('headless', { text: 'Ignored.' }, undefined, undefined, context('session-1', false)),
    ).resolves.toMatchObject({
      details: { outcome: 'failed', error: { code: 'VOICE_TOOL_HOST_UNAVAILABLE' } },
    });
    headless.session.dispose();
    headless.voiceTools.dispose();

    const stale = fixture();
    stale.session.setActive(false);
    await expect(
      stale.tool.execute('stale', { text: 'Ignored.' }, undefined, undefined, stale.boundContext),
    ).resolves.toMatchObject({ details: { outcome: 'failed', error: { code: 'VOICE_TOOL_INACTIVE' } } });
    stale.session.dispose();
    stale.voiceTools.dispose();

    const mismatch = fixture();
    await expect(
      mismatch.tool.execute('mismatch', { text: 'Ignored.' }, undefined, undefined, context('session-2')),
    ).resolves.toMatchObject({ details: { outcome: 'failed', error: { code: 'VOICE_TOOL_STALE_SESSION' } } });
    await expect(
      mismatch.tool.execute('recycled', { text: 'Ignored.' }, undefined, undefined, context('session-1')),
    ).resolves.toMatchObject({ details: { outcome: 'failed', error: { code: 'VOICE_TOOL_STALE_SESSION' } } });
    expect(mismatch.narrateAgent).not.toHaveBeenCalled();
    mismatch.session.dispose();
    mismatch.voiceTools.dispose();
  });

  it('accepts the 4,096-character boundary and shares narration normalization', async () => {
    const h = fixture();
    const boundary = 'x'.repeat(4_096);

    await h.tool.execute('boundary', { text: boundary }, undefined, undefined, h.boundContext);
    await h.tool.execute('normalized', { text: '  Ready\n\tto speak.  ' }, undefined, undefined, h.boundContext);

    expect(h.narrateAgent).toHaveBeenNthCalledWith(1, boundary, undefined);
    expect(h.narrateAgent).toHaveBeenNthCalledWith(2, 'Ready to speak.', undefined);
    h.session.dispose();
    h.voiceTools.dispose();
  });

  it('fails closed for an unbound runtime and over-limit direct input', async () => {
    const h = fixture();
    h.setRuntime(undefined);
    await expect(
      h.tool.execute('unbound', { text: 'Ignored.' }, undefined, undefined, h.boundContext),
    ).resolves.toMatchObject({ details: { error: { code: 'VOICE_TOOL_HOST_UNAVAILABLE' } } });

    h.setRuntime({ context: h.boundContext, session: h.session, controller: h.controller });
    await expect(
      h.tool.execute('blank', { text: ' \n\t ' }, undefined, undefined, h.boundContext),
    ).resolves.toMatchObject({ details: { error: { code: 'VOICE_TOOL_INVALID_INPUT' } } });
    await expect(
      h.tool.execute('large', { text: 'x'.repeat(4_097) }, undefined, undefined, h.boundContext),
    ).resolves.toMatchObject({ details: { error: { code: 'VOICE_TOOL_INVALID_INPUT' } } });
    expect(h.narrateAgent).not.toHaveBeenCalled();
    h.session.dispose();
    h.voiceTools.dispose();
  });

  it('maps a session replacement during playback to interrupted', async () => {
    const h = fixture();
    const completion = deferred<NarrationToolOutcome>();
    h.narrateAgent.mockImplementationOnce(async () => completion.promise);
    const result = h.tool.execute('replace', { text: 'In flight.' }, undefined, undefined, h.boundContext);
    await Promise.resolve();

    h.setRuntime({
      ...({ context: h.boundContext, session: h.session, controller: h.controller } satisfies NarrationToolRuntime),
    });
    completion.resolve('completed');

    await expect(result).resolves.toMatchObject({ details: { outcome: 'interrupted' } });
    h.session.dispose();
    h.voiceTools.dispose();
  });
});
