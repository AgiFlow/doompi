import type { AgentProfile } from '@agimon-ai/doompi-config/profiles';
import { createVoiceReloadHandoffStore } from '@agimon-ai/doompi-voice/voice-reload-handoff';
import { createDoomVoiceToolsService } from '@agimon-ai/doompi-voice/voice-tools';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProfileVoiceCapability, type ProfileVoiceView } from '../../src/controllers/voiceTool';
import { bindStubCoordinator } from '../helpers/coordinator';

const SESSION_ID = 'profile-voice-session';

const profile = (name: string, displayName?: string): AgentProfile => ({
  name,
  persona: `agents/acme/${name}`,
  personaRoot: '/repo',
  env: {},
  ...(displayName === undefined ? {} : { identity: { name: displayName } }),
});

let disposeAll: (() => void)[] = [];

function setup(view: Partial<ProfileVoiceView> = {}) {
  const messages: { content: string; options: unknown }[] = [];
  const pi = {
    sendUserMessage: vi.fn((content: string, options: unknown) => {
      messages.push({ content, options });
    }),
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: 'rpc',
    hasUI: true,
    ui: { notify: vi.fn() },
    sessionManager: { getSessionId: () => SESSION_ID, getBranch: () => [] },
  } as unknown as ExtensionContext;

  const cordis = new Context();
  disposeAll.push(() => void cordis.fiber.dispose());
  disposeAll.push(
    bindStubCoordinator(cordis, SESSION_ID, { domains: [], majorMode: 'copilot', layers: [], profile: 'writer' })
      .dispose,
  );

  const voiceTools = createDoomVoiceToolsService<ExtensionContext>(`profile-test:${crypto.randomUUID()}`);
  const reloadHandoffs = createVoiceReloadHandoffStore({
    now: () => Date.now(),
    createToken: () => crypto.randomUUID(),
  });
  const resolved: ProfileVoiceView = {
    current: 'writer',
    profiles: [profile('writer'), profile('rhea', 'Rhea')],
    ...view,
  };
  const disposeCapability = registerProfileVoiceCapability(
    voiceTools,
    pi,
    async () => resolved,
    reloadHandoffs,
    () => cordis,
  );
  const session = voiceTools.bindSession(SESSION_ID, ctx);
  session.setActive(true);
  disposeAll.push(() => {
    disposeCapability();
    session.dispose();
    voiceTools.dispose();
  });

  const call = async (input: Record<string, unknown>) => {
    const catalogToken = session.describe().catalogToken;
    return session.executeBatch({ catalogToken, calls: [{ name: 'profile', input }] }, ctx);
  };
  return { call, messages, pi, reloadHandoffs, session };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const dispose of disposeAll.reverse()) dispose();
  disposeAll = [];
});

describe('profile voice capability', () => {
  it('publishes one capability the facade can describe', () => {
    const { session } = setup();

    expect(session.describe().tools.map((tool) => tool.name)).toEqual(['profile']);
  });

  it('lists profiles with their display names', async () => {
    const { call } = setup();

    const batch = await call({ action: 'list' });

    expect(batch.results[0]?.result).toEqual({
      status: 'listed',
      current: 'writer',
      profiles: [
        { name: 'writer', description: 'agents/acme/writer' },
        { name: 'rhea', description: 'agents/acme/rhea', displayName: 'Rhea' },
      ],
    });
  });

  it('queues a switch, stops the batch, and keeps the profile name out of the message', async () => {
    const { call, messages, reloadHandoffs, session } = setup();

    const batch = await call({ action: 'switch', profile: 'rhea' });

    expect(batch.results[0]?.result).toEqual({ status: 'queued', profile: 'rhea', stopBatch: 'session-reload' });
    expect(batch.status).toBe('stopped');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toMatch(/^\/profile --voice-switch-token=voice-reload:/u);
    // An edited transcript must not be able to redirect the switch.
    expect(messages[0]?.content).not.toContain('rhea');
    expect(messages[0]?.options).toEqual({ deliverAs: 'followUp', expandPromptTemplates: true });

    const token = messages[0]?.content.split('=')[1];
    if (!token) throw new Error('voice switch token was not queued');
    // The command commits before reloading; only then can the replacement
    // session read the parked profile back.
    expect(reloadHandoffs.commit(token, { sessionId: SESSION_ID, hostGeneration: session.hostGeneration })).toBe(true);
    expect(reloadHandoffs.consume(SESSION_ID)).toMatchObject({ kind: 'profile-switch', profile: 'rhea' });
  });

  it('reports an unchanged profile without queuing anything', async () => {
    const { call, messages } = setup();

    const batch = await call({ action: 'switch', profile: 'writer' });

    expect(batch.results[0]?.result).toEqual({ status: 'unchanged', profile: 'writer' });
    expect(messages).toHaveLength(0);
  });

  it('refuses an unknown profile, leaving nothing parked', async () => {
    const { call, messages, reloadHandoffs } = setup();

    const batch = await call({ action: 'switch', profile: 'ghost' });

    expect(batch.results[0]?.error).toBeDefined();
    expect(messages).toHaveLength(0);
    expect(reloadHandoffs.consume(SESSION_ID)).toBeUndefined();
  });

  it('discards the handoff when the follow-up cannot be delivered', async () => {
    const { call, pi, reloadHandoffs } = setup();
    vi.mocked(pi.sendUserMessage).mockImplementationOnce(() => {
      throw new Error('the session went away');
    });

    const batch = await call({ action: 'switch', profile: 'rhea' });

    expect(batch.results[0]?.error).toBeDefined();
    expect(reloadHandoffs.consume(SESSION_ID)).toBeUndefined();
  });
});
