import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { desktopRuntimePlugin } from './scripts/desktopRuntimePlugin.ts';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = path.resolve(packageRoot, '..', '..', '..');
const outDir = path.join(packageRoot, 'build', 'runtime');
const source = (...segments: string[]): string => path.join(workspaceRoot, ...segments);

export default defineConfig({
  plugins: [desktopRuntimePlugin({ outDir, workspaceRoot })],
  build: {
    ssr: true,
    outDir,
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: {
        'doompi-web/dist/bin/serve': source('packages/clients/doompi-web/src/bin/serve.ts'),
        'doompi-web/dist/index': source('packages/clients/doompi-web/src/exports/index.ts'),
        'doompi-web/dist/bundler': source('packages/clients/doompi-web/src/exports/bundler.ts'),
        'doompi-server/dist/bin/serve': source('packages/clients/doompi-server/src/bin/serve.ts'),
        'doompi/dist/bin/cli': source('packages/core/doompi/src/bin/cli.ts'),
        'doompi/dist/bin/doomRunner': source('packages/core/doompi/src/bin/doomRunner.ts'),
        'doompi/dist/bin/dpi': source('packages/core/doompi/src/bin/dpi.ts'),
        'doompi/dist/src/adapters/syncedRuntimeBuilder': source(
          'packages/core/doompi/src/adapters/syncedRuntimeBuilder.ts',
        ),
        'doompi/dist/src/extensions/entries/cordisFinalizer': source(
          'packages/core/doompi/src/extensions/entries/cordisFinalizer.ts',
        ),
        'doompi/dist/src/extensions/entries/cordisHost': source(
          'packages/core/doompi/src/extensions/entries/cordisHost.ts',
        ),
        'doompi/dist/src/extensions/entries/effort': source('packages/core/doompi/src/extensions/entries/effort.ts'),
        'doompi/dist/src/extensions/entries/launcherBootstrap': source(
          'packages/core/doompi/src/extensions/entries/launcherBootstrap.ts',
        ),
        'doompi/dist/src/extensions/entries/modeCatalog': source(
          'packages/core/doompi/src/extensions/entries/modeCatalog.ts',
        ),
        'doompi/dist/src/extensions/entries/ollamaProvider': source(
          'packages/core/doompi/src/extensions/entries/ollamaProvider.ts',
        ),
        'doompi/dist/src/extensions/entries/transitionCoordinator': source(
          'packages/core/doompi/src/extensions/entries/transitionCoordinator.ts',
        ),
        'doompi/dist/src/services/extensionAssembler': source(
          'packages/core/doompi/src/services/extensionAssembler.ts',
        ),
      },
      output: {
        format: 'es',
        entryFileNames: '[name].mjs',
        chunkFileNames: 'chunks/[name]-[hash].mjs',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  ssr: {
    noExternal: true,
  },
});
