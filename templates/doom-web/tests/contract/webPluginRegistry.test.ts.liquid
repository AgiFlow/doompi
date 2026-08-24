import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderBuiltinWebPluginModules } from '../../src/adapters/webPluginGenerate.ts';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('the committed builtin web plugin registry', () => {
  it('matches what the host doompiWeb manifest produces right now', async () => {
    // The committed generated modules must equal a fresh render: a manifest
    // edit without regeneration fails here (and in CI's check-mode build).
    for (const [relativePath, content] of renderBuiltinWebPluginModules()) {
      await expect(readFile(path.join(packageRoot, relativePath), 'utf8'), relativePath).resolves.toBe(content);
    }
  });

  it('contains only the host package plugins, never a hardcoded external', () => {
    // External plugins reach the cockpit through the doompi sync bundle, not
    // through this package's own build: the committed registry must not name
    // any other package.
    const rendered = renderBuiltinWebPluginModules();
    const client = rendered.get(path.join('src', 'web', 'app', 'webPlugins.generated.ts'));
    expect(client).toContain("from '../features/subagents/index.ts'");
    expect(client).not.toContain('@agimon-ai/doompi-workflow');
    expect(client).not.toContain('file://');
    const hub = rendered.get(path.join('src', 'adapters', 'webHubPlugins.generated.ts'));
    expect(hub).toContain('...subagentsChannels');
    expect(hub).not.toContain('doompi-workflow');
  });
});
