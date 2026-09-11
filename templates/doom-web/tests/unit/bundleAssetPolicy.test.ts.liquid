import { describe, expect, it } from 'vitest';
import { classifyOptionalBundleAssets } from '../../src/adapters/bundleAssetPolicy.ts';
import { parseBundleAssetPolicy } from '../../src/types/bundleAssetPolicy.ts';

describe('bundle asset policy', () => {
  it('defers Mermaid and the PDF worker through graph ownership, while shared output stays eager', () => {
    expect(
      classifyOptionalBundleAssets({
        'assets/app.js': {
          type: 'chunk',
          isEntry: true,
          modules: { '/src/main.ts': {} },
          dynamicImports: ['assets/mermaid.js', 'assets/pdf.js'],
          imports: ['assets/shared.js'],
        },
        'assets/mermaid.js': {
          type: 'chunk',
          modules: { '/node_modules/mermaid/dist/mermaid.js': {} },
          imports: ['assets/shared.js'],
        },
        'assets/pdf.js': {
          type: 'chunk',
          modules: { '/node_modules/pdfjs-dist/webpack.mjs': {} },
          code: 'const worker = new URL("/assets/pdf.worker.js", import.meta.url);',
        },
        'assets/pdf.worker.js': { type: 'asset' },
        'assets/shared.js': { type: 'chunk', modules: { '/node_modules/react/index.js': {} } },
        'assets/logo.svg': { type: 'asset' },
      }),
    ).toEqual(['/assets/mermaid.js', '/assets/pdf.js', '/assets/pdf.worker.js']);
  });

  it('keeps an unclassified or eager-owned dependency out of the optional policy', () => {
    expect(
      classifyOptionalBundleAssets({
        'app.js': {
          type: 'chunk',
          isEntry: true,
          facadeModuleId: '/src/main.ts',
          modules: { '/src/main.ts': {} },
          imports: ['mermaid.js', 'shared.js'],
        },
        'mermaid.js': { type: 'chunk', modules: { '/node_modules/mermaid/dist/mermaid.js': {} } },
        'shared.js': { type: 'chunk', modules: { '/node_modules/d3/index.js': {} } },
      }),
    ).toEqual([]);
  });

  it('keeps mixed application and optional-package chunks eager', () => {
    expect(
      classifyOptionalBundleAssets({
        'app.js': { type: 'chunk', isEntry: true, modules: { '/src/main.ts': {} }, dynamicImports: ['mixed.js'] },
        'mixed.js': { type: 'chunk', modules: { '/src/feature.ts': {}, '/node_modules/mermaid/index.js': {} } },
      }),
    ).toEqual([]);
  });

  it('defers transitive vendor modules only with module-graph evidence', () => {
    const bundle = {
      'app.js': {
        type: 'chunk' as const,
        isEntry: true,
        modules: { '/src/main.ts': {} },
        dynamicImports: ['mermaid.js'],
      },
      'mermaid.js': {
        type: 'chunk' as const,
        modules: { '/node_modules/mermaid/index.js': {}, '/node_modules/d3/index.js': {} },
      },
    };
    expect(classifyOptionalBundleAssets(bundle)).toEqual([]);
    expect(
      classifyOptionalBundleAssets(bundle, (id) =>
        id === '/node_modules/mermaid/index.js' ? ['/node_modules/d3/index.js'] : [],
      ),
    ).toEqual(['/mermaid.js']);
  });

  it('keeps mixed transitive chunks and HTML-owned resources eager and excludes source maps', () => {
    expect(
      classifyOptionalBundleAssets({
        'index.html': { type: 'asset', source: '<link href="assets/shared.css">' },
        'app.js': { type: 'chunk', isEntry: true, modules: { '/src/main.ts': {} }, dynamicImports: ['mermaid.js'] },
        'mermaid.js': {
          type: 'chunk',
          modules: { '/node_modules/mermaid/index.js': {} },
          imports: ['mixed.js'],
          referencedFiles: ['assets/shared.css', 'mermaid.js.map'],
        },
        'mixed.js': { type: 'chunk', modules: { '/src/feature.ts': {}, '/node_modules/mermaid/helper.js': {} } },
        'assets/shared.css': { type: 'asset' },
        'mermaid.js.map': { type: 'asset' },
      }),
    ).toEqual(['/mermaid.js']);
  });

  it('rejects unsupported, duplicate, and non-root-relative policy paths', () => {
    expect(parseBundleAssetPolicy({ version: 1, optional: ['/assets/pdf.js'] })).toEqual({
      version: 1,
      optional: ['/assets/pdf.js'],
    });
    expect(parseBundleAssetPolicy({ version: 2, optional: [] })).toBeUndefined();
    expect(parseBundleAssetPolicy({ version: 1, optional: ['/a.js', '/a.js'] })).toBeUndefined();
    expect(parseBundleAssetPolicy({ version: 1, optional: ['https://example.test/a.js'] })).toBeUndefined();
  });
});
