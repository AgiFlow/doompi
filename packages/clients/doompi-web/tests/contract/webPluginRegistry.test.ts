import * as fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { renderBuiltinWebPluginModules, writeSyncWebPluginModules } from '../../src/adapters/webPluginGenerate.ts';
import { scanWebPlugins } from '../../src/adapters/webPluginScan.ts';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('the committed builtin web plugin registry', () => {
  it('matches what the host doompiWeb manifest produces right now', async () => {
    // The committed generated modules must equal a fresh render: a manifest
    // edit without regeneration fails here (and in CI's check-mode build).
    for (const [relativePath, content] of renderBuiltinWebPluginModules()) {
      await expect(readFile(path.join(packageRoot, relativePath), 'utf8'), relativePath).resolves.toBe(content);
    }
  });

  it('is empty: every tab and channel is a plugin, never a hardcoded builtin', () => {
    // The host package declares no plugins of its own any more; the whole
    // set reaches the cockpit through the doompi sync bundle, so the
    // committed registry must stay empty and name no other package.
    const rendered = renderBuiltinWebPluginModules();
    const client = rendered.get(path.join('src', 'web', 'app', 'webPlugins.generated.ts'));
    expect(client).toContain('export const webPlugins: readonly WebPluginDefinition[] = [];');
    expect(client).not.toContain('file://');
    const hub = rendered.get(path.join('src', 'adapters', 'webHubPlugins.generated.ts'));
    expect(hub).toContain('export const BUILTIN_HUB_CHANNELS: readonly WebHubChannel[] = [];');
  });

  // A plugin's classes are scanned from the directory its components live in.
  // The client entry is published through a one-line src/exports re-export, so
  // deriving the scan root from the entry path would point Tailwind at
  // src/exports and silently drop every class the panels use.
  describe('the Tailwind source directive for an installed plugin', () => {
    const scratch: string[] = [];

    afterEach(() => {
      for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    });

    function pluginPackage(webRoot: string, client: string): string {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-web-plugin-src-')));
      scratch.push(dir);
      fs.mkdirSync(path.join(dir, webRoot), { recursive: true });
      fs.mkdirSync(path.join(dir, path.dirname(client)), { recursive: true });
      fs.writeFileSync(path.join(dir, webRoot, 'index.ts'), 'export const webPlugin = {};');
      fs.writeFileSync(path.join(dir, client), `export { webPlugin } from '../web/index.ts';`);
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: `@scope/${path.basename(dir)}`,
          doompiWeb: { pluginId: 'demo', client: `./${client}` },
        }),
      );
      return dir;
    }

    function cssFor(packageDir: string): string {
      const generated = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-web-generated-'));
      scratch.push(generated);
      const host = fileURLToPath(new URL('../..', import.meta.url));
      const plugins = scanWebPlugins(host, [packageDir], () => undefined);
      const { cssModulePath } = writeSyncWebPluginModules(plugins, generated);
      return fs.readFileSync(cssModulePath, 'utf8');
    }

    it('names src/web when the client is re-exported from src/exports', () => {
      const dir = pluginPackage('src/web', path.join('src', 'exports', 'webClient.ts'));
      expect(cssFor(dir)).toContain(`@source "${path.join(dir, 'src', 'web')}";`);
    });

    it('falls back to the entry directory for a plugin with no src/web root', () => {
      const dir = pluginPackage('web', path.join('web', 'index.ts'));
      expect(cssFor(dir)).toContain(`@source "${path.join(dir, 'web')}";`);
    });
  });
});
