import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { globalDoomConfigPath, loadDoomConfigLayers, repositoryDoomConfigPath } from '../src/services/config';
import { configScopeOf, mergeDoomConfigs, parseDoomConfig } from '../src/services/configPolicy';
import { writeDoomConfigValues } from '../src/services/configWriter';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const parse = (text: string) => parseDoomConfig(text, 'config.yaml');

describe('web template configuration', () => {
  it('accepts third-party identifiers without depending on an installed browser registry', () => {
    expect(parse('web:\n  template: acme-reader\n').web).toEqual({ template: 'acme-reader' });
    expect(configScopeOf(['web', 'template'])).toBe('both');
  });

  it.each([
    'web: []',
    'web: { template: 3 }',
    'web: { template: "" }',
    'web: { template: "../layout" }',
    'web: { source: x }',
  ])('rejects malformed configuration: %s', (text) => {
    expect(() => parse(text)).toThrow();
  });

  it('lets a workspace override the global default while an empty mapping inherits it', () => {
    const global = parse('web: { template: doompi-template-advanced }');
    expect(mergeDoomConfigs(global, parse('web: { template: doompi-template-elegant }')).web?.template).toBe(
      'doompi-template-elegant',
    );
    expect(mergeDoomConfigs(global, parse('web: {}')).web?.template).toBe('doompi-template-advanced');
    expect(mergeDoomConfigs(global, parse('')).web?.template).toBe('doompi-template-advanced');
    expect(mergeDoomConfigs(parse(''), parse('')).web).toBeUndefined();
  });

  it('persists and clears scoped defaults with accurate origin and no unrelated changes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-template-config-'));
    directories.push(directory);
    const home = path.join(directory, 'home');
    const repo = path.join(directory, 'repo');
    const global = globalDoomConfigPath(home);
    const local = repositoryDoomConfigPath(repo);
    fs.mkdirSync(path.dirname(global), { recursive: true });
    fs.writeFileSync(global, '# preserve\neditor:\n  command: vim\n');
    await writeDoomConfigValues(global, [{ keyPath: ['web', 'template'], value: 'doompi-template-advanced' }], {
      scope: 'global',
    });
    let view = loadDoomConfigLayers(repo, home);
    expect(view.originOf(['web', 'template'])).toBe('global');
    await writeDoomConfigValues(local, [{ keyPath: ['web', 'template'], value: 'doompi-template-elegant' }], {
      scope: 'repository',
    });
    view = loadDoomConfigLayers(repo, home);
    expect(view.valueAt(['web', 'template'])).toBe('doompi-template-elegant');
    expect(view.originOf(['web', 'template'])).toBe('repository');
    await writeDoomConfigValues(local, [{ keyPath: ['web', 'template'] }], { scope: 'repository' });
    view = loadDoomConfigLayers(repo, home);
    expect(view.valueAt(['web', 'template'])).toBe('doompi-template-advanced');
    expect(view.originOf(['web', 'template'])).toBe('global');
    expect(fs.readFileSync(global, 'utf8')).toContain('# preserve');
    expect(fs.readFileSync(global, 'utf8')).toContain('command: vim');
  });
});
