import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { DoomMcpUiBundle } from '@agimon-ai/doompi-core/mcpFacet';

export interface McpAppSource {
  readonly file: string;
  readonly widgets: readonly string[];
}

/** Composes the installed packages' browser registries. No tool names or presentation policies live here. */
export async function bundleMcpApp(
  sources: readonly McpAppSource[],
  outputDirectory: string,
): Promise<DoomMcpUiBundle | undefined> {
  if (sources.length === 0) return undefined;
  const names = new Set<string>();
  for (const source of sources) {
    for (const name of source.widgets) {
      if (names.has(name)) throw new Error(`Duplicate MCP widget '${name}'`);
      names.add(name);
    }
  }
  const runtimeRequire = createRequire(import.meta.url);
  const coreRoot = path.dirname(runtimeRequire.resolve('@agimon-ai/doompi-core/package.json'));
  const componentsRoot = path.dirname(runtimeRequire.resolve('@agimon-ai/doompi-web-components/package.json'));
  const componentsManifest = JSON.parse(fs.readFileSync(path.join(componentsRoot, 'package.json'), 'utf8')) as {
    exports: Record<string, { import: string }>;
  };
  const appEntry = path.resolve(componentsRoot, componentsManifest.exports['./mcpWidget']!.import);
  const reactRequire = createRequire(path.join(coreRoot, 'package.json'));
  const directory = path.join(outputDirectory, 'ui');
  fs.mkdirSync(directory, { recursive: true });
  const outputRoot = fs.realpathSync(outputDirectory);
  const entry = path.join(directory, 'entry.js');
  const css = path.join(directory, 'app.css');
  const relative = (file: string): string => file.split(path.sep).join('/');
  fs.writeFileSync(
    entry,
    [
      `import { mountMcpApp } from ${JSON.stringify(relative(appEntry))};`,
      "import './app.css';",
      ...sources.map(
        (source, index) => `import { widgets as widgets${index} } from ${JSON.stringify(relative(source.file))};`,
      ),
      'const widgets = Object.create(null);',
      ...sources.flatMap((source, index) =>
        source.widgets.map((name) => `widgets[${JSON.stringify(name)}] = widgets${index}[${JSON.stringify(name)}];`),
      ),
      'void mountMcpApp(widgets);',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    css,
    [
      `@import ${JSON.stringify(relative(runtimeRequire.resolve('tailwindcss/index.css')))};`,
      `@import ${JSON.stringify(relative(path.join(componentsRoot, 'styles/mcp.css')))};`,
      `@source ${JSON.stringify(relative(path.join(componentsRoot, 'dist')))};`,
      ...sources.map((source) => `@source ${JSON.stringify(relative(source.file))};`),
      '',
    ].join('\n'),
  );
  const inputs = new Set<string>([
    appEntry,
    path.join(coreRoot, 'package.json'),
    path.join(componentsRoot, 'package.json'),
  ]);
  for (const root of [
    path.join(componentsRoot, 'styles'),
    path.dirname(runtimeRequire.resolve('tailwindcss/package.json')),
  ]) {
    for (const file of fs.readdirSync(root, { recursive: true })) {
      if (typeof file === 'string' && file.endsWith('.css')) inputs.add(path.join(root, file));
    }
  }
  const { build } = await import('vite');
  const { default: tailwindcss } = await import('@tailwindcss/vite');
  const built = await build({
    configFile: false,
    envDir: false,
    root: directory,
    logLevel: 'warn',
    // Library builds leave this React branch intact unless it is replaced explicitly.
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins: [
      tailwindcss(),
      {
        name: 'doompi-mcp-inputs',
        generateBundle() {
          for (const id of this.getModuleIds()) {
            const file = id.split('?')[0]!;
            if (file.includes('\0') || !path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile())
              continue;
            const resolved = fs.realpathSync(file);
            const withinOutput = path.relative(outputRoot, resolved);
            if (withinOutput !== '' && !withinOutput.startsWith('..') && !path.isAbsolute(withinOutput)) continue;
            inputs.add(resolved);
          }
        },
      },
    ],
    resolve: {
      alias: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].map(
        (specifier) => ({
          find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'u'),
          replacement: reactRequire.resolve(specifier),
        }),
      ),
    },
    build: {
      write: false,
      emptyOutDir: false,
      sourcemap: false,
      cssCodeSplit: false,
      assetsInlineLimit: 0,
      lib: { entry, formats: ['iife'], name: 'DoompiMcpApp', fileName: 'app', cssFileName: 'app' },
    },
  });
  const bundles = Array.isArray(built) ? built : [built];
  const output = bundles.flatMap((bundle) => ('output' in bundle ? bundle.output : []));
  const scripts = output.filter((item) => item.type === 'chunk');
  const styles = output.filter((item) => item.type === 'asset').filter((item) => item.fileName.endsWith('.css'));
  if (
    scripts.length !== 1 ||
    scripts[0]!.imports.length ||
    scripts[0]!.dynamicImports.length ||
    output.length !== scripts.length + styles.length
  )
    throw new Error('The composed MCP app must contain one self-contained script and inline CSS only.');
  const script = scripts[0]!.code.replace(/<\/script/giu, '<\\/script');
  const style = styles
    .map((item) => (typeof item.source === 'string' ? item.source : Buffer.from(item.source).toString('utf8')))
    .join('\n')
    .replace(/<\/style/giu, '<\\/style');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Doompi tools</title><style>${style}</style></head><body><div id="root"></div><script>${script}</script></body></html>`;
  fs.writeFileSync(path.join(directory, 'index.html'), html);
  // Only immutable HTML is served. The generated imports remain useful for diagnosing a sync build.
  return {
    file: './ui/index.html',
    sha256: crypto.createHash('sha256').update(html).digest('hex'),
    inputs: [...inputs]
      .sort()
      .map((file) => ({ path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') })),
  };
}
