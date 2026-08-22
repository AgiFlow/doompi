import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));

function source(relativePath: string): string {
  return fs.readFileSync(path.join(packageDirectory, relativePath), 'utf8');
}

/** Static value imports only: type-only imports and `import()` calls cost nothing at runtime. */
function runtimeImports(text: string): string[] {
  return (text.match(/^import\s[\s\S]*?from\s+'[^']+';$/gmu) ?? []).filter(
    (statement) => !statement.startsWith('import type'),
  );
}

/**
 * Every session registers `/domains`; almost none run it.
 *
 * The plugin catalogue, the resource collector and the picker are the expensive
 * part of this package, so the modules a session pays for at startup are pinned
 * here: a static import creeping into any of them charges every session for a
 * command it will not use.
 */
describe('startup module graph', () => {
  const startupModules = [
    'src/adapters/pi/extension.ts',
    'src/adapters/pi/voiceTool.ts',
    'src/adapters/domainCatalog.ts',
    'src/commands/domainsCommand.ts',
  ];

  it('keeps the domain manifest, the switch and the picker behind dynamic imports', () => {
    for (const relativePath of startupModules) {
      const imports = runtimeImports(source(relativePath)).join('\n');

      expect(imports, relativePath).not.toContain('@agimon-ai/doompi-config/domains');
      expect(imports, relativePath).not.toContain('matrixPicker');
      expect(imports, relativePath).not.toContain('applyDomains');
      expect(imports, relativePath).not.toContain('resourceCollector');
      expect(imports, relativePath).not.toContain('pluginMaterializer');
    }
  });

  it('resolves defaultDomainsForMajorMode from the dynamically imported manifest module', () => {
    const catalog = source('src/adapters/domainCatalog.ts');

    expect(catalog).toContain("import('@agimon-ai/doompi-config/domains')");
    expect(catalog).toContain('defaultDomainsForMajorMode');
    expect(runtimeImports(catalog).join('\n')).not.toContain('defaultDomainsForMajorMode');
  });

  it('does not reach for the config root barrel from any startup module', () => {
    for (const relativePath of startupModules) {
      expect(source(relativePath), relativePath).not.toMatch(/from ['"]@agimon-ai\/doompi-config['"]/u);
    }
  });

  it('emits the lazy switch import into the built Pi entry', () => {
    const built = path.join(packageDirectory, 'dist', 'adapters', 'pi', 'extension.mjs');
    if (!fs.existsSync(built)) return;

    expect(fs.readFileSync(built, 'utf8')).toMatch(/import\(`\.\.\/applyDomains\.mjs`\)/u);
  });
});
