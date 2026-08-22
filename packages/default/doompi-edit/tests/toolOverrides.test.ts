import {
  DOOM_TOOL_OVERRIDES_SERVICE,
  createDoomToolOverridesService,
} from '@agimon-ai/doompi-extension-contracts/tool-overrides';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { installDoomPiEditRuntime } from '../src/adapters/pi/extension.ts';

async function installWith(service: ReturnType<typeof createDoomToolOverridesService>): Promise<{
  readonly names: readonly string[];
  dispose(): Promise<void>;
}> {
  const root = new Context();
  const provider = root.plugin((context) => context.provide(DOOM_TOOL_OVERRIDES_SERVICE, service));
  await provider.await();
  const names: string[] = [];
  const pi = {
    registerTool: vi.fn((tool: ToolDefinition) => names.push(tool.name)),
  } as unknown as ExtensionAPI;
  const feature = root.plugin((context) => installDoomPiEditRuntime(context, pi));
  await feature.await();
  return {
    names,
    async dispose() {
      await feature.dispose();
      await root.fiber.dispose();
    },
  };
}

describe('doompi-edit tool ownership', () => {
  it('registers edit when its claim succeeds', async () => {
    const service = createDoomToolOverridesService('runtime-1');
    const fixture = await installWith(service);

    expect(fixture.names).toEqual(['edit']);
    expect(service.owner('edit')).toBe('@agimon-ai/doompi-edit');
    await fixture.dispose();
    expect(service.owner('edit')).toBeUndefined();
  });

  it('does not register when another extension owns edit', async () => {
    const service = createDoomToolOverridesService('runtime-1');
    service.claim({ source: '@example/other', tools: ['edit'] });
    const fixture = await installWith(service);

    expect(fixture.names).toEqual([]);
    expect(service.owner('edit')).toBe('@example/other');
    await fixture.dispose();
  });
});
