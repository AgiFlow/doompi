import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateExtension } from '../src/services/generate';
import { scanExtensions } from '../src/services/scan';
import { syncMcpManifest } from '../src/services/syncManifest';
import { doompiExtension } from '../src/services/tsdownPreset';

const temporary: string[] = [];
const route = 'src/extensions/workspaces/sessions';
function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-mcp-widgets-'));
  temporary.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@test/tools' }));
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(root, route, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  return root;
}
afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const backend = 'export default { name: "read" };';
const widget = 'export default function Widget() { return null; }';

describe('package-owned MCP widgets', () => {
  it('generates browser components separately and binds their backend tools without importing React into Node', () => {
    const root = fixture({ '(backend)/tool/read.mcp.ts': backend, '(frontend)/tool/read.mcp.tsx': widget });
    const generated = generateExtension({ packageDir: root, target: 'mcp' });
    expect(generated.notices).toEqual([]);
    const node = generated.files.get('generated/mcp.ts')!;
    const browser = generated.files.get('generated/mcp-ui.ts')!;
    expect(node).toContain('withWidget("@test/tools/read",');
    expect(node).not.toContain('(frontend)');
    expect(node).not.toContain("from 'react'");
    expect(browser).toContain('(frontend)/tool/read.mcp');
    expect(browser).toContain('"@test/tools/read": Widget0');
    const normal = generateExtension({ packageDir: root });
    expect(normal.files.has('generated/web.ts')).toBe(false);
    expect(fs.existsSync(path.join(root, 'generated/mcp-ui.ts'))).toBe(true);
  });

  it('maps every dynamically contributed tool and preserves optional absence', () => {
    const root = fixture({
      '(backend)/tool/catalog.mcp.ts':
        'import { defineRoutedContribution } from "@agimon-ai/doompi-core/extensionFile"; export default defineRoutedContribution(() => [], { cardinality: "many" });',
      '(frontend)/tool/catalog.mcp.tsx': widget,
      '(backend)/tool/optional.mcp.ts':
        'import { defineRoutedContribution } from "@agimon-ai/doompi-core/extensionFile"; export default defineRoutedContribution(() => undefined, { cardinality: "optional" });',
      '(frontend)/tool/optional.mcp.tsx': widget,
    });
    const node = generateExtension({ packageDir: root, target: 'mcp' }).files.get('generated/mcp.ts')!;
    expect(node).toContain('.map((tool) => withWidget("@test/tools/catalog", tool))');
    expect(node).toContain('withWidget("@test/tools/optional",');
    expect(node).toContain('value === undefined ? value');
    expect(node).toContain('defined(');
  });

  it('rejects an orphan or ambiguous widget instead of silently registering a fallback', () => {
    const root = fixture({ '(frontend)/tool/read.mcp.tsx': widget });
    expect(() => generateExtension({ packageDir: root, target: 'mcp' })).toThrow('must match exactly one backend tool');
    const duplicates = fixture({
      '(backend)/tool/read.mcp.ts': backend,
      '(frontend)/tool/read.mcp.tsx': widget,
      '(backend)/mode/plan/tool/read.mcp.ts': backend,
      '(frontend)/mode/plan/tool/read.mcp.tsx': widget,
    });
    expect(() => generateExtension({ packageDir: duplicates, target: 'mcp' })).toThrow('Duplicate MCP widget');
  });

  it('removes obsolete browser registries and emits no empty UI bundle', () => {
    const root = fixture({ '(backend)/tool/read.mcp.ts': backend, '(frontend)/tool/read.mcp.tsx': widget });
    generateExtension({ packageDir: root, target: 'mcp' });
    fs.unlinkSync(path.join(root, route, '(frontend)/tool/read.mcp.tsx'));
    const generated = generateExtension({ packageDir: root, target: 'mcp' });
    expect(generated.files.has('generated/mcp-ui.ts')).toBe(false);
    expect(fs.existsSync(path.join(root, 'generated/mcp-ui.ts'))).toBe(false);
    expect(generated.files.get('generated/mcp.ts')).not.toContain('withWidget');
  });

  it('adds a browser-only build and publishes only generated widget metadata', () => {
    const root = fixture({ '(backend)/tool/read.mcp.ts': backend, '(frontend)/tool/read.mcp.tsx': widget });
    const configs = doompiExtension({ packageDir: root, target: 'mcp' });
    expect(Array.isArray(configs)).toBe(true);
    expect(configs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: 'browser',
          tsconfig: 'tsconfig.mcp.json',
          entry: { 'extensions/mcp-ui': 'generated/mcp-ui.ts' },
        }),
      ]),
    );
    expect(syncMcpManifest({ name: '@test/tools' }, true, ['@test/tools/read'])).toMatchObject({
      doompiMcp: { ui: { dist: './dist/extensions/mcp-ui.mjs', widgets: ['@test/tools/read'] } },
    });
    expect(syncMcpManifest({}, true)).toEqual({
      doompiMcp: { entry: './generated/mcp.ts', dist: './dist/extensions/mcp.mjs', scopes: ['session'] },
    });
  });

  it('provides exactly one package-owned widget for every supported remote tool declaration', () => {
    const repository = path.resolve(import.meta.dirname, '../../../..');
    const roots = ['packages', 'layers'].flatMap((directory) =>
      fs
        .readdirSync(path.join(repository, directory), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((category) =>
          fs
            .readdirSync(path.join(repository, directory, category.name), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(repository, directory, category.name, entry.name)),
        ),
    );
    let count = 0;
    for (const root of roots) {
      if (!fs.existsSync(path.join(root, 'package.json'))) continue;
      const graph = scanExtensions({ packageDir: root });
      const tools = graph.entries.filter(
        (entry) => entry.platform === 'mcp' && entry.side === 'backend' && entry.surface === 'tool',
      );
      for (const tool of tools) {
        const widgets = graph.entries.filter(
          (entry) =>
            entry.platform === 'mcp' &&
            entry.side === 'frontend' &&
            entry.surface === 'tool' &&
            entry.name === tool.name,
        );
        expect(
          widgets.map((entry) => entry.file),
          tool.file,
        ).toEqual([tool.file.replace('(backend)', '(frontend)').replace(/\.ts$/u, '.tsx')]);
        count += 1;
      }
    }
    expect(count).toBeGreaterThanOrEqual(21);
  });
});
