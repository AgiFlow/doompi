import {
  DOOM_TOOL_OVERRIDES_SERVICE,
  createDoomToolOverridesService,
} from '@agimon-ai/doompi-extension-contracts/tool-overrides';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { installDoomPiGrepRuntime } from '../src/adapters/pi/extension.ts';

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
  const feature = root.plugin((context) => installDoomPiGrepRuntime(context, pi));
  await feature.await();
  return {
    names,
    async dispose() {
      await feature.dispose();
      await root.fiber.dispose();
    },
  };
}

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
