import {
  createDoomToolSurface,
  DOOM_TOOL_SURFACE_SERVICE,
  type DoomToolSurfaceService,
} from '@agimon-ai/doompi-extension-contracts/tool-surface';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { voiceRuntime } from './helpers/voiceRuntime';
import type { VoiceDependencies } from '../src/types';
import type { RealtimeHost } from '../src/services/realtimeHost';
import type { RealtimeSignInAttempt } from '../src/services/realtimeRuntime';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  vi.useRealTimers();
});
async function settle() {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}
async function fixture(mode: 'live' | 'legacy' = 'live') {
  const cordis = new Context();
  const commands = new Map<string, { handler(args: string, context: ExtensionContext): Promise<void> }>();
  const events = new Map<string, (event: object, context: ExtensionContext) => Promise<void>>();
  const tools = new Map<string, { name: string; execute(...args: unknown[]): unknown }>();
  const branch: ReturnType<ExtensionContext['sessionManager']['getBranch']> = [];
  let activeTools = ['read'];
  let toolSurface: DoomToolSurfaceService | undefined;
  const context = {
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getSessionId: () => 'session-live', getBranch: () => branch },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  } as unknown as ExtensionContext;
  const pi = {
    registerCommand: (name: string, command: { handler(args: string, context: ExtensionContext): Promise<void> }) =>
      commands.set(name, command),
    on: (event: string, handler: (event: object, context: ExtensionContext) => Promise<void>) => {
      const previous = events.get(event);
      events.set(event, async (value, ctx) => {
        await previous?.(value, ctx);
        await handler(value, ctx);
      });
    },
    registerTool: (tool: { name: string; execute(...args: unknown[]): unknown }) => {
      tools.set(tool.name, tool);
      toolSurface?.refresh();
    },
    getAllTools: () => [...tools.values()],
    getActiveTools: () => activeTools,
    setActiveTools: vi.fn((names: string[]) => {
      activeTools = names;
    }),
    setModel: vi.fn(),
    getSessionName: () => 'Voice test',
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  const manual = { state: 'idle', toggle: vi.fn(async () => undefined), shutdown: vi.fn(async () => undefined) };
  const dependencies = {
    sessionController: manual,
    configs: { load: () => ({ voice: { mode } }) },
    clock: {
      now: () => Date.now(),
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clear: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    },
    tts: { stop: vi.fn() },
  } as unknown as VoiceDependencies;
  const host = {
    start: vi.fn(async () => undefined),
    poll: vi.fn<RealtimeHost['poll']>(async (activationId) => ({
      activationId,
      state: 'connecting',
      cursor: 0,
      events: [],
    })),
    stop: vi.fn(async () => undefined),
    send: vi.fn<RealtimeHost['send']>(async () => undefined),
    control: vi.fn(async () => undefined),
  } satisfies RealtimeHost;
  const cancel = vi.fn();
  let finishLogin!: () => void;
  let failLogin!: (error: Error) => void;
  const attempt: RealtimeSignInAttempt = {
    authorizationUrl: 'https://example.invalid/consented-login',
    completion: new Promise<void>((resolve, reject) => {
      finishLogin = resolve;
      failLogin = reject;
    }),
    cancel,
  };
  const signIn = vi.fn(async (_signal: AbortSignal) => attempt);
  const waitUntilConfigured = vi.fn(async () => undefined);
  toolSurface = createDoomToolSurface({
    generation: 'voice-live-test',
    // 'read' stands in for the host's own tools: the surface only removes, so it
    // has to start from the whole registered inventory.
    allTools: () => ['read', ...tools.keys()],
    activeTools: () => activeTools,
    setActiveTools: (names) => {
      activeTools = [...names];
    },
  });
  cordis.provide(DOOM_TOOL_SURFACE_SERVICE, toolSurface);
  await voiceRuntime.install(cordis, pi, { dependencies, liveHost: host, liveSignIn: signIn, waitUntilConfigured });
  disposers.push(async () => {
    await cordis.fiber.dispose();
  });
  const command = async (name: string, args = '') => {
    const entry = commands.get(name);
    if (!entry) throw new Error(`Missing command ${name}`);
    await entry.handler(args, context);
    await settle();
  };
  return {
    cordis,
    pi,
    branch,
    command,
    events,
    tools,
    context,
    host,
    signIn,
    cancel,
    manual,
    waitUntilConfigured,
    finishLogin,
    failLogin,
  };
}

describe('production live voice command wiring', () => {
  it('reports login startup failure without exposing authentication details', async () => {
    const f = await fixture();
    f.signIn.mockRejectedValueOnce(new Error('private-provider-credential'));
    await f.command('voice-auto', 'login');
    expect(f.context.ui.notify).toHaveBeenCalledWith(
      'Could not start subscription sign-in. Check that localhost port 1455 is available.',
      'error',
    );
    expect(f.host.start).not.toHaveBeenCalled();
  });

  it('reports login completion without activating media', async () => {
    const f = await fixture();
    await f.command('voice-auto', 'login');
    f.finishLogin();
    await settle();
    expect(f.context.ui.notify).toHaveBeenLastCalledWith(
      'Subscription sign-in completed. Activate live voice explicitly when ready.',
      'info',
    );
    expect(f.host.start).not.toHaveBeenCalled();
  });

  it('reports login failure but suppresses completion of a cancelled attempt', async () => {
    const failed = await fixture();
    await failed.command('voice-auto', 'login');
    failed.failLogin(new Error('private-login-error'));
    await settle();
    expect(failed.context.ui.notify).toHaveBeenLastCalledWith(
      'Subscription sign-in failed or timed out. Run /voice-auto login to try again.',
      'error',
    );
    const cancelled = await fixture();
    await cancelled.command('voice-auto', 'login');
    await cancelled.command('voice-auto', 'login-cancel');
    vi.mocked(cancelled.context.ui.notify).mockClear();
    cancelled.finishLogin();
    await settle();
    expect(cancelled.context.ui.notify).not.toHaveBeenCalled();
    expect(cancelled.host.start).not.toHaveBeenCalled();
  });
  it('does not gate live tool descriptions or failed narration on local ASR', async () => {
    const f = await fixture();
    await f.events.get('session_start')!({}, f.context);
    f.host.poll.mockImplementation(async (activationId) => ({ activationId, state: 'active', cursor: 0, events: [] }));
    await f.command('voice-auto');
    await f.tools.get('describe_voice_tools')!.execute('describe', {}, undefined, undefined, f.context);
    await f.tools
      .get('narrate')!
      .execute('narrate', { text: 'Exact narration is unqualified.' }, undefined, undefined, f.context);
    expect(f.waitUntilConfigured).not.toHaveBeenCalled();
    await f.command('voice-auto', 'end');
  });
  it('does not sign in or activate during installation or session restoration', async () => {
    const f = await fixture();
    await settle();
    await f.events.get('session_start')!({ reason: 'reload' }, f.context);
    expect(f.signIn).not.toHaveBeenCalled();
    expect(f.host.start).not.toHaveBeenCalled();
  });

  it('starts only explicit subscription login and cancels it without activating capture', async () => {
    const f = await fixture();
    await f.command('voice-auto', 'login');
    expect(f.signIn).toHaveBeenCalledOnce();
    expect(f.context.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Microphone capture stays off'), 'info');
    expect(f.host.start).not.toHaveBeenCalled();
    await f.command('voice-auto', 'login-cancel');
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.signIn.mock.calls[0]![0].aborted).toBe(true);
  });

  it('cancels a pending login on session change', async () => {
    const f = await fixture();
    await f.command('voice-auto', 'login');
    await f.events.get('session_start')!({ reason: 'switch' }, f.context);
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.signIn.mock.calls[0]![0].aborted).toBe(true);
  });

  it('bypasses local ASR for explicit live activation and excludes manual capture', async () => {
    const f = await fixture();
    await f.command('voice-auto');
    expect(f.waitUntilConfigured).not.toHaveBeenCalled();
    expect(f.host.start).toHaveBeenCalledOnce();
    await f.command('voice');
    expect(f.manual.toggle).not.toHaveBeenCalled();
    await f.command('voice-auto', 'end');
    expect(f.host.stop).toHaveBeenCalledOnce();
  });

  it('does not route legacy activation to the live host', async () => {
    const f = await fixture('legacy');
    await f.command('voice-auto');
    expect(f.waitUntilConfigured).toHaveBeenCalledOnce();
    expect(f.host.start).not.toHaveBeenCalled();
  });

  it('rejects unknown controls rather than implicitly enabling live capture', async () => {
    const f = await fixture();
    await f.command('voice-auto', 'resume');
    expect(f.context.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Usage:'), 'info');
    expect(f.host.start).not.toHaveBeenCalled();
  });
  it('steers the primary Pi agent and returns its actual result without narrate or model switching', async () => {
    const f = await fixture();
    await f.events.get('session_start')!({}, f.context);
    vi.spyOn(f.context, 'isIdle').mockReturnValue(false);
    f.host.poll.mockImplementation(async (activationId, after) => ({
      activationId,
      state: 'active',
      cursor: 2,
      events:
        after === 0
          ? [
              {
                sequence: 1,
                event: { type: 'transcript', role: 'user', text: 'Run the harmless fixture', complete: true },
              },
              { sequence: 2, event: { type: 'request', requestId: 'native-request', text: 'Companion reformulation' } },
            ]
          : [],
    }));
    await f.command('voice-auto');
    expect(f.pi.sendUserMessage).toHaveBeenCalledExactlyOnceWith('Run the harmless fixture', { deliverAs: 'steer' });
    expect(f.pi.getActiveTools()).toContain('read');
    expect(f.pi.getActiveTools()).not.toContain('narrate');
    expect(f.pi.setModel).not.toHaveBeenCalled();
    f.branch.push({
      type: 'message',
      id: 'pi-final',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Fixture returned receipt fixture-456.' }],
      },
    } as (typeof f.branch)[number]);
    await f.events.get('agent_settled')!({}, f.context);
    await f.events.get('agent_settled')!({}, f.context);
    const results = f.host.send.mock.calls
      .flatMap((call) => call[1].map((value) => JSON.parse(value)))
      .filter((value) => value.channel === 'speakable');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: 'delegation.context.append', delegation_item_id: 'native-request' });
    expect(results[0].content[0].text).toContain('fixture-456');
    await f.command('voice-auto', 'end');
    expect(f.pi.getActiveTools()).toEqual(['read']);
  });
});
