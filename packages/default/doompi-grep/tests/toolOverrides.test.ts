import { DOOM_TOOL_OVERRIDES_SERVICE, createDoomToolOverridesService } from '@agimon-ai/doompi-core/tool-overrides';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { extension } from '../generated/pi';

async function installWith(service: ReturnType<typeof createDoomToolOverridesService>): Promise<{
  readonly names: readonly string[];
  readonly registered: readonly ToolDefinition[];
  dispose(): Promise<void>;
}> {
  const root = new Context();
  const provider = root.plugin((context) => context.provide(DOOM_TOOL_OVERRIDES_SERVICE, service));
  await provider.await();
  const registered: ToolDefinition[] = [];
  const pi = {
    on: vi.fn(),
    registerTool: vi.fn((tool: ToolDefinition) => registered.push(tool)),
  } as unknown as ExtensionAPI;
  const feature = root.plugin((context) => extension.install(context, pi));
  await feature.await();
  return {
    names: registered.map((tool) => tool.name),
    registered,
    async dispose() {
      await feature.dispose();
      await root.fiber.dispose();
    },
  };
}

describe('doompi-grep terminal presentation', () => {
  it('reaches Pi with the renderers the frontend sibling supplies', async () => {
    // The pair is authored apart: execute in (backend)/tool/grep.cli.ts, the
    // three render fields in (frontend)/tool/grep.cli.ts. Only the merged
    // registration proves the generated entry put them back together, and
    // this tool claims a name through definePiTool, which owns its own
    // registration, so the merge has to reach inside it.
    const fixture = await installWith(createDoomToolOverridesService('runtime-render'));
    const grep = fixture.registered.find((tool) => tool.name === 'grep');

    expect(grep?.renderShell).toBe('self');
    expect(typeof grep?.renderCall).toBe('function');
    expect(typeof grep?.renderResult).toBe('function');
    await fixture.dispose();
  });
});

describe('doompi-grep tool ownership', () => {
  it('registers and releases only grep when its claim succeeds', async () => {
    const service = createDoomToolOverridesService('runtime-1');
    const fixture = await installWith(service);

    expect(fixture.names).toEqual(['grep']);
    expect(service.owner('grep')).toBe('@agimon-ai/doompi-grep');
    expect(service.owner('read')).toBeUndefined();
    expect(service.owner('edit')).toBeUndefined();
    await fixture.dispose();
    expect(service.owner('grep')).toBeUndefined();
  });

  it('does not register when another extension owns grep', async () => {
    const service = createDoomToolOverridesService('runtime-1');
    service.claim({ source: '@example/other', tools: ['grep'] });
    const fixture = await installWith(service);

    expect(fixture.names).toEqual([]);
    expect(service.owner('grep')).toBe('@example/other');
    await fixture.dispose();
  });
});
