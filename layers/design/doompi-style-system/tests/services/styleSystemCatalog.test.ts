import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StyleSystemCatalogService } from '../../src/services/styleSystemCatalog';

let root: string;
function write(file: string, content: string): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function story(title: string, tags = ['style-system']): string {
  return `const meta = { title: '${title}', tags: ${JSON.stringify(tags)} };\nexport default meta;\nexport const Playground = {};\nexport const Small = { name: 'Small button' };`;
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-style-catalog-'));
  fs.mkdirSync(path.join(root, '.git'));
  write(
    'style-system.config.yaml',
    'root: true\nsharedComponentTags: [shared]\ndefaults:\n  type: tailwind\npresets:\n  web:\n    colorScheme: dark\n',
  );
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('style-system catalog', () => {
  it('discovers independent configs, preserves duplicate titles and config-less shared stories', async () => {
    write('apps/a/style-system.config.yaml', 'extends: web\n');
    write('apps/b/style-system.config.yaml', 'extends: web\n');
    write('apps/a/Button.stories.tsx', story('Button', ['shared']));
    write('apps/b/Button.stories.tsx', story('Button'));
    write('packages/ui/Button.stories.tsx', story('Button', ['shared']));
    write('templates/sample/style-system.config.yaml', 'extends: web\n');
    write('node_modules/vendor/Button.stories.tsx', story('Ignored'));
    write('dist/Button.stories.tsx', story('Ignored'));
    const catalog = await new StyleSystemCatalogService(root).read();
    expect(catalog.projects.map((project) => project.appPath)).toEqual(['apps/a', 'apps/b']);
    expect(catalog.projects[0].provenance.presets).toEqual(['web']);
    expect(catalog.projects[0].settings.colorScheme).toBe('dark');
    expect(catalog.workspace?.configPath).toBe('style-system.config.yaml');
    expect(catalog.components).toHaveLength(3);
    expect(catalog.components.find((component) => component.storyPath.startsWith('packages/'))).toMatchObject({
      shared: true,
      projectPath: undefined,
    });
    expect(catalog.components.find((component) => component.storyPath.startsWith('apps/a/'))).toMatchObject({
      projectPath: 'apps/a',
      shared: true,
    });
    expect(catalog.components[0].exports.map((variant) => variant.exportName)).toEqual(['Playground', 'Small']);
  });

  it('still discovers configs and stories after a large unrelated asset listing', async () => {
    write('packages/ui/style-system.config.yaml', 'extends: web\n');
    write('packages/ui/Button.stories.tsx', story('Button', ['shared']));
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const asset = { isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true };
    const crowded = [
      ...Array.from({ length: 20001 }, (_, index) => ({ ...asset, name: `000-asset-${index}.png` })),
      ...entries,
    ];
    const listing = vi
      .spyOn(fs.promises, 'readdir')
      .mockResolvedValueOnce(crowded as unknown as Awaited<ReturnType<typeof fs.promises.readdir>>);
    try {
      const catalog = await new StyleSystemCatalogService(root).read();
      expect(catalog.projects.map((project) => project.appPath)).toEqual(['packages/ui']);
      expect(catalog.workspace?.configPath).toBe('style-system.config.yaml');
      expect(catalog.components).toHaveLength(1);
      expect(catalog.truncated).toBe(false);
    } finally {
      listing.mockRestore();
    }
  });

  it('returns partial diagnostics, skips escaping symlinks, and refreshes cached metadata', async () => {
    write('apps/bad/style-system.config.yaml', 'extends: missing\n');
    write('apps/bad/Bad.stories.tsx', 'export const = ;');
    write('packages/ui/Good.stories.tsx', story('Good'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-style-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'Outside.stories.tsx'), story('Outside'));
      fs.symlinkSync(outside, path.join(root, 'outside'));
      const service = new StyleSystemCatalogService(root);
      const catalog = await service.read();
      expect(catalog.components.map((component) => component.title)).toEqual(['Good']);
      expect(catalog.projects[0].error).toContain('missing');
      expect(catalog.diagnostics).toHaveLength(2);
      write('packages/ui/New.stories.tsx', story('New'));
      expect((await service.read()).components).toHaveLength(1);
      expect((await service.read({ refresh: true })).components).toHaveLength(2);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
