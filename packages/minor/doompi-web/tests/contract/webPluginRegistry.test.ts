import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderWebPluginModules } from '../../scripts/webPlugins/generate.mjs';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('the generated web plugin registry', () => {
  it('matches what the doompiWeb manifests produce right now', async () => {
    // The committed generated modules must equal a fresh render: a manifest
    // edit without regeneration fails here (and in CI's check-mode build).
    for (const [relativePath, content] of renderWebPluginModules()) {
      await expect(readFile(path.join(packageRoot, relativePath), 'utf8'), relativePath).resolves.toBe(content);
    }
  });

  it('registers the internal and cross-package plugins in order', () => {
    const rendered = renderWebPluginModules();
    const client = rendered.get(path.join('src', 'web', 'app', 'webPlugins.generated.ts'));
    expect(client).toContain("from '../features/subagents/index.ts'");
    expect(client).toContain("from '@agimon-ai/doompi-workflow/web'");
    expect(client).toContain('subagentsPlugin, workflowsPlugin');
    const hub = rendered.get(path.join('src', 'adapters', 'webHubPlugins.generated.ts'));
    expect(hub).toContain('...subagentsChannels');
    expect(hub).toContain("specifier: '@agimon-ai/doompi-workflow/web-hub'");
    const css = rendered.get(path.join('src', 'web', 'styles', 'webPluginSources.generated.css'));
    expect(css).toContain('@source "../../../../doompi-workflow/web";');
  });
});
