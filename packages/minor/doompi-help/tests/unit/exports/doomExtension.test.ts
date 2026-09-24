import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { connectDoomCordisHost, installDoomCordisHost } from '@agimon-ai/doompi-core/cordisHost';
import { readDoomHelpService } from '@agimon-ai/doompi-core/help';
import { DOOM_MINOR_MODE_CATALOG_SERVICE } from '@agimon-ai/doompi-minor-mode';
import { createMinorModeCatalogHost } from '@agimon-ai/doompi-minor-mode/catalog';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { extension as helpExtension } from '../../../generated/pi';

type Handler = (...args: unknown[]) => unknown;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'doom-help-pi-'));
  cleanup.push(() => rm(cacheRoot, { recursive: true, force: true }));
  const commands = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]>();
  const tools = new Map<string, Parameters<ExtensionAPI['registerTool']>[0]>();
  const handlers = new Map<string, Set<Handler>>();
  const events = new Map<string, Set<(value: unknown) => void>>();
  let active = ['read'];
  const pi = {
    events: {
      emit(name: string, value: unknown) {
        for (const listener of events.get(name) ?? []) listener(value);
      },
      on(name: string, listener: (value: unknown) => void) {
        const listeners = events.get(name) ?? new Set();
        listeners.add(listener);
        events.set(name, listeners);
        return () => listeners.delete(listener);
      },
    },
    on(name: string, handler: Handler) {
      const current = handlers.get(name) ?? new Set();
      current.add(handler);
      handlers.set(name, current);
      return () => current.delete(handler);
    },
    registerCommand(name: string, command: Parameters<ExtensionAPI['registerCommand']>[1]) {
      commands.set(name, command);
    },
    registerTool(tool: Parameters<ExtensionAPI['registerTool']>[0]) {
      tools.set(tool.name, tool);
      active = [...new Set([...active, tool.name])];
    },
    getAllTools: () => [{ name: 'read' }, ...tools.values()],
    getActiveTools: () => active,
    setActiveTools(names: string[]) {
      active = names;
    },
  } as unknown as ExtensionAPI;
  await installDoomCordisHost(pi, { mode: 'composed', source: 'help-test-host' });
  await helpExtension(pi, { cacheRoot });
  const connection = await connectDoomCordisHost(pi, 'help-test');
  const context = {
    cwd: cacheRoot,
    hasUI: false,
    sessionManager: { getSessionId: () => 'help-session', getBranch: () => [] },
  } as unknown as ExtensionContext;
  const dispatch = async (event: string) => {
    // Session handlers can replace registrations during dispatch.
    const listeners = Array.from(handlers.get(event) ?? []);
    for (const handler of listeners) await handler({ type: event, reason: 'startup' }, context);
  };
  cleanup.push(async () => {
    await dispatch('session_shutdown');
    await connection.dispose();
  });
  await dispatch('session_start');
  const command = commands.get('doom-help');
  const tool = tools.get('help_status');
  if (!command || !tool) throw new Error('Help entry did not register its command and diagnostic tool.');
  return { pi, commands, tools, connection, context, dispatch, command, tool, active: () => active };
}

describe('standard Help extension', () => {
  it('gates its real diagnostic through activation, ordinary tool composition, and stale execution', async () => {
    const current = await fixture();
    const service = readDoomHelpService(current.connection.root)!;
    expect(service.listContributions()).toEqual([expect.objectContaining({ source: '@agimon-ai/doompi-help' })]);
    expect(current.active()).toEqual(['read']);
    await expect(current.tool.execute('off', {}, undefined, undefined, current.context)).rejects.toThrow('inactive');
    const unbind = service.bindSkillInventory(async () => service.getSnapshot().skills.map((skill) => skill.filePath));
    try {
      await current.command.handler('', current.context as Parameters<typeof current.command.handler>[1]);
      expect(service.getSnapshot().activation).toBe('active');
      expect(current.active()).toEqual(['read', 'help_status']);
      const result = await current.tool.execute('on', {}, undefined, undefined, current.context);
      expect(result.details).toMatchObject({ activation: 'active', counts: { skills: 1, tools: 1 } });
      await current.command.handler('', current.context as Parameters<typeof current.command.handler>[1]);
      expect(service.getSnapshot().skills).toEqual([]);
      expect(current.active()).toEqual(['read']);
      await expect(current.tool.execute('stale', {}, undefined, undefined, current.context)).rejects.toThrow(
        'inactive',
      );
    } finally {
      unbind();
    }
  });

  it('replaces the session-owned Help provider and starts the new session inactive', async () => {
    const current = await fixture();
    const first = readDoomHelpService(current.connection.root)!;
    await current.command.handler('', current.context as Parameters<typeof current.command.handler>[1]);
    await current.dispatch('session_start');
    const second = readDoomHelpService(current.connection.root)!;
    expect(second).toBeDefined();
    expect(second.generation).not.toBe(first.generation);
    expect(second.getSnapshot().activation).toBe('inactive');
    expect(current.active()).toEqual(['read']);
    expect(await first.inspectSkills()).toBeUndefined();
  });
  it('updates a late minor-mode catalog from the accepted skill inventory and disposes its subscriptions', async () => {
    const current = await fixture();
    const catalog = createMinorModeCatalogHost({ sessionKind: 'headless', context: current.context });
    const provider = current.connection.root.plugin((context) => {
      context.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, catalog);
    });
    await provider;
    cleanup.push(async () => {
      await provider.dispose();
      catalog.dispose();
    });
    await vi.waitFor(() => expect(catalog.list()).toHaveLength(1));
    const service = readDoomHelpService(current.connection.root)!;
    await current.command.handler('', current.context as Parameters<typeof current.command.handler>[1]);
    await vi.waitFor(() =>
      expect(catalog.list()[0]?.state).toMatchObject({
        activation: 'active',
        condition: 'degraded',
        detail: 'pending Help skills, 1 diagnostic tools (diagnostics available)',
      }),
    );
    const unbind = service.bindSkillInventory(async () => service.getSnapshot().skills.map((skill) => skill.filePath));
    cleanup.push(async () => {
      unbind();
    });
    await current.command.handler('', current.context as Parameters<typeof current.command.handler>[1]);
    await current.command.handler('', current.context as Parameters<typeof current.command.handler>[1]);
    await vi.waitFor(() =>
      expect(catalog.list()[0]?.state).toMatchObject({
        activation: 'active',
        condition: 'ready',
        detail: '1 Help skills, 1 diagnostic tools',
      }),
    );
    await provider.dispose();
    expect(catalog.list()).toEqual([]);
    await current.command.handler('', current.context as Parameters<typeof current.command.handler>[1]);
    expect(current.active()).toEqual(['read']);
  });
});
