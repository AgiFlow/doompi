import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDoomVoiceToolsService } from '@agimon-ai/doompi-extension-contracts/voice-tools';
import { createVoiceReloadHandoffStore } from '@agimon-ai/doompi-extension-contracts/voice-reload-handoff';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDomainSwitchHandoffStore } from '../../src/adapters/domainSwitchHandoff.ts';
import { registerDomainVoiceCapabilities } from '../../src/adapters/pi/voiceTool.ts';
import type { DomainCatalogPort } from '../../src/commands/domainsCommand.ts';
import { bindStubCoordinator } from '../helpers/coordinator.ts';
import { bindConfig } from '../helpers/session.ts';

const SESSION_ID = 'domain-voice-session';

let root: string;
let disposeAll: Array<() => void> = [];

function setup(catalogOverrides: Partial<DomainCatalogPort> = {}) {
  const messages: Array<{ content: string; options: Record<string, unknown> }> = [];
  const handlers = new Map<string, Array<(event: unknown, context: ExtensionContext) => unknown>>();
  const pi = {
    on: vi.fn((event: string, handler: (event: unknown, context: ExtensionContext) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn((content: string, options: Record<string, unknown>) => {
      messages.push({ content, options });
    }),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    mode: 'rpc',
    hasUI: true,
    ui: { notify: vi.fn(), custom: vi.fn(), addAutocompleteProvider: vi.fn() },
    sessionManager: { getSessionId: () => SESSION_ID, getBranch: () => [] },
    waitForIdle: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
  } as unknown as ExtensionContext;

  const cordis = new Context();
  bindConfig(cordis, root);
  disposeAll.push(() => void cordis.fiber.dispose());
  disposeAll.push(
    bindStubCoordinator(cordis, SESSION_ID, { domains: ['default'], majorMode: 'copilot', layers: [] }).dispose,
  );

  const handoffs = createDomainSwitchHandoffStore();
  disposeAll.push(() => {
    handoffs.dispose();
  });
  const catalog: DomainCatalogPort = {
    list: async () => ({ active: ['default'], effective: ['default'], available: ['default', 'development', 'qa'] }),
    validate: async (_ctx, values) => [...values],
    describe: async () => ({}),
    completions: async () => undefined,
    ...catalogOverrides,
  };
  const voiceTools = createDoomVoiceToolsService<ExtensionContext>(`domain-test:${crypto.randomUUID()}`);
  const reloadHandoffs = createVoiceReloadHandoffStore({
    now: () => Date.now(),
    createToken: () => crypto.randomUUID(),
  });
  const disposeCapabilities = registerDomainVoiceCapabilities(
    voiceTools,
    pi,
    catalog,
    handoffs,
    reloadHandoffs,
    () => cordis,
  );
  const session = voiceTools.bindSession(SESSION_ID, ctx);
  session.setActive(true);
  disposeAll.push(() => {
    for (const handler of handlers.get('session_shutdown') ?? []) void handler({}, ctx);
    disposeCapabilities();
    session.dispose();
    voiceTools.dispose();
  });

  const call = async (name: string, input: Record<string, unknown>) => {
    const catalogToken = session.describe().catalogToken;
    return session.executeBatch({ catalogToken, calls: [{ name, input }] }, ctx);
  };
  return { call, ctx, handoffs, messages, pi, reloadHandoffs, session };
}

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-voice-'));
});

afterEach(() => {
  for (const dispose of disposeAll.reverse()) dispose();
  disposeAll = [];
  fs.rmSync(root, { recursive: true, force: true });
});

describe('domain voice tools', () => {
  it('registers both tools under this package as their source', () => {
    const { session } = setup();

    expect(session.describe().tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['list_domains', 'switch_domains']),
    );
  });

  it('lists the active, effective and available sets', async () => {
    const { call } = setup();

    const listing = await call('list_domains', {});

    expect(listing.results[0]?.result).toEqual({
      active: ['default'],
      effective: ['default'],
      available: ['default', 'development', 'qa'],
    });
  });

  it('queues an opaque follow-up rather than switching, and stops the batch', async () => {
    const { call, messages } = setup();

    const switched = await call('switch_domains', { domains: ['development', 'qa'] });

    expect(switched.results[0]?.result).toEqual({ status: 'queued', stopBatch: 'session-reload' });
    expect(switched.status).toBe('stopped');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toMatch(/^\/domains --voice-switch-token=doom-domain-switch:/u);
    // The selection travels in the store, so an edited transcript cannot
    // rewrite which domains the follow-up applies.
    expect(messages[0]?.content).not.toContain('development');
    expect(messages[0]?.content).not.toContain('qa');
    expect(messages[0]?.options).toMatchObject({ deliverAs: 'followUp', expandPromptTemplates: true });
  });

  it('parks an explicit empty selection alongside a committable reload handoff', async () => {
    const { call, handoffs, messages, reloadHandoffs, session } = setup();

    await call('switch_domains', { domains: [] });

    const token = messages[0]?.content.split('=').at(1);
    if (!token) throw new Error('voice switch token was not queued');
    const parked = handoffs.consume(token, { sessionId: SESSION_ID, hostGeneration: session.hostGeneration });
    expect(parked).toMatchObject({ domains: [] });
    if (!parked) throw new Error('the switch was not parked');

    // The command commits the reload handoff before reloading; only then does
    // the replacement session get to read the selection back.
    expect(
      reloadHandoffs.commit(parked.reloadHandoffToken, {
        sessionId: parked.sessionId,
        hostGeneration: parked.hostGeneration,
      }),
    ).toBe(true);
    expect(reloadHandoffs.consume(SESSION_ID)).toMatchObject({ domains: [] });
  });

  it('refuses a selection the manifest does not declare, leaving nothing parked', async () => {
    const { call, messages } = setup({
      validate: async () => {
        throw new Error('Unknown domain: ghost');
      },
    });

    const result = await call('switch_domains', { domains: ['ghost'] });

    expect(result.results[0]?.error).toBeDefined();
    expect(messages).toHaveLength(0);
  });

  it('discards both handoffs when the follow-up cannot be delivered', async () => {
    const { call, handoffs, pi, reloadHandoffs } = setup();
    vi.mocked(pi.sendUserMessage).mockImplementationOnce(() => {
      throw new Error('the session went away');
    });

    const result = await call('switch_domains', { domains: ['development'] });

    expect(result.results[0]?.error).toBeDefined();
    expect(handoffs.dispose()).toBe(0);
    expect(reloadHandoffs.consume(SESSION_ID)).toBeUndefined();
  });
});
