import {
  createDoomVoiceToolsService,
  type VoiceToolDefinition,
  VoiceToolDescribeInputSchema,
} from '@agimon-ai/doompi-extension-contracts/voice-tools';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { registerVoiceToolFacades } from '../src/adapters/pi/voiceTools.ts';
import { AutonomousTurnIdentityFactory } from '../src/services/autonomousTurn.ts';
import type { IClock } from '../src/types/index.ts';

type RegisteredTool = ToolDefinition;

function context(sessionId: string): ExtensionContext {
  return {
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

/** The text Pi actually sends to the model, as opposed to the `details` the TUI reads. */
function describeText(result: { content?: unknown } | undefined): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .map((block) => (typeof block === 'object' && block !== null ? ((block as { text?: string }).text ?? '') : ''))
    .join('\n');
}

function definition(name: string): VoiceToolDefinition<ExtensionContext> {
  return {
    descriptor: {
      source: '@test/voice',
      id: `${name}-id`,
      name,
      label: name,
      description: `Description for ${name}`,
      order: 1,
      inputSchema: VoiceToolDescribeInputSchema,
      resultSchema: VoiceToolDescribeInputSchema,
    },
    // Must satisfy `resultSchema` above, or the call fails validation before it returns.
    execute: vi.fn(async () => ({ names: [name] })),
  };
}

describe('voice Pi façade tools', () => {
  it('registers both stable tools, refreshes descriptions, and executes through the bound session', async () => {
    const registered = new Map<string, RegisteredTool>();
    const pi = {
      registerTool: (tool: RegisteredTool) => registered.set(tool.name, tool),
    };
    const voiceTools = createDoomVoiceToolsService<ExtensionContext>('voice-facade-test');
    const registration = voiceTools.register(definition('transcribe'));
    const session = voiceTools.bindSession('facade-session', context('facade-session'));
    const facades = registerVoiceToolFacades(pi as unknown as Pick<ExtensionAPI, 'registerTool'>, () => session);

    expect([...registered.keys()]).toEqual(['describe_voice_tools', 'use_voice_tools']);
    for (const tool of registered.values()) {
      expect(tool).toMatchObject({
        renderShell: 'self',
        renderCall: expect.any(Function),
        renderResult: expect.any(Function),
      });
    }
    const describe = registered.get('describe_voice_tools');
    const use = registered.get('use_voice_tools');
    expect(describe).toBeDefined();
    expect(use).toBeDefined();

    // The description is fixed protocol text now, not a rebuilt capability dump.
    expect(describe?.description).toContain('catalog token');
    expect(describe?.description).not.toContain('transcribe');
    expect(describe?.promptGuidelines?.join('\n')).toContain('before every use_voice_tools batch');
    expect(use?.promptGuidelines?.join('\n')).toContain('verbatim');

    session.setActive(true);
    const described = await describe?.execute('describe-1', {}, undefined, undefined, context('facade-session'));
    const snapshot = described?.details;
    expect(snapshot).toMatchObject({ tools: [{ name: 'transcribe' }] });
    if (!snapshot || typeof snapshot !== 'object' || !('catalogToken' in snapshot))
      throw new Error('missing catalog snapshot');
    const catalogToken = String(snapshot.catalogToken);

    // The whole point: the token the model must echo back reaches it through `content`,
    // because Pi never shows `details` to the model.
    const describedText = describeText(described);
    expect(describedText).toContain(`<catalog_token>${catalogToken}</catalog_token>`);
    expect(describedText).toContain('<capability name="transcribe" enabled="true">');
    expect(describedText).not.toContain('<input_schema>');

    const detailed = await describe?.execute(
      'describe-2',
      { names: ['transcribe'] },
      undefined,
      undefined,
      context('facade-session'),
    );
    expect(describeText(detailed)).toContain('<input_schema>');

    const used = await use?.execute(
      'use-1',
      { catalogToken, calls: [{ name: 'transcribe', input: {} }] },
      undefined,
      undefined,
      context('facade-session'),
    );
    expect(used?.details).toMatchObject({ status: 'completed' });
    const usedText = describeText(used);
    expect(usedText).toContain('<voice_tool_batch status="completed">');
    expect(usedText).toContain('<result>{"names":["transcribe"]}</result>');

    registration.dispose();
    facades.dispose();
    session.dispose();
    voiceTools.dispose();
  });

  it('fails closed for an unbound or stale session context', async () => {
    const registered = new Map<string, RegisteredTool>();
    const pi = { registerTool: (tool: RegisteredTool) => registered.set(tool.name, tool) };
    const facades = registerVoiceToolFacades(pi as unknown as Pick<ExtensionAPI, 'registerTool'>, () => undefined);
    const describe = registered.get('describe_voice_tools');
    const unavailable = await describe?.execute('describe-3', {}, undefined, undefined, context('missing'));
    expect(unavailable?.details).toMatchObject({ error: { code: 'VOICE_TOOL_HOST_UNAVAILABLE' } });
    expect(describeText(unavailable)).toContain('<voice_tool_error code="VOICE_TOOL_HOST_UNAVAILABLE"');

    const voiceTools = createDoomVoiceToolsService<ExtensionContext>('voice-stale-session-test');
    const session = voiceTools.bindSession('real-session', context('real-session'));
    const stale = await registered
      .get('use_voice_tools')
      ?.execute(
        'use-2',
        { catalogToken: 'stale', calls: [{ name: 'missing', input: {} }] },
        undefined,
        undefined,
        context('other-session'),
      );
    expect(stale?.details).toMatchObject({ error: { code: 'VOICE_TOOL_HOST_UNAVAILABLE' } });
    facades.dispose();
    session.dispose();
    voiceTools.dispose();
  });
});

describe('autonomous voice identity freshness', () => {
  const clock: IClock = {
    now: () => 0,
    setTimeout: () => ({}) as never,
    setInterval: () => ({}) as never,
    clear: () => undefined,
  };

  it('includes the injected nonce in every fresh identity', () => {
    const factory = new AutonomousTurnIdentityFactory(clock, () => 'reload-nonce');
    const sessionId = factory.createSession();
    const turn = factory.createTurn(sessionId);
    expect(sessionId).toContain('reload-nonce');
    expect(turn.captureId).toContain('reload-nonce');
    expect(turn.turnId).toContain('reload-nonce');
  });

  it('rejects an empty injected nonce', () => {
    expect(() => new AutonomousTurnIdentityFactory(clock, () => '  ')).toThrow('nonce');
  });
});
