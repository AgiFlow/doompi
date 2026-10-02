import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

import { desktopRuntimePlugin } from './scripts/desktopRuntimePlugin';

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
        'doompi/dist/bin/serve': source('packages/cli/doompi/src/bin/serve.ts'),
        'doompi/dist/bin/cli': source('packages/cli/doompi/src/bin/cli.ts'),
        'doompi/dist/bin/doomRunner': source('packages/cli/doompi/src/bin/doomRunner.ts'),
        'doompi/dist/bin/dpi': source('packages/cli/doompi/src/bin/dpi.ts'),
        'doompi/dist/builders/cli/index': source('packages/cli/doompi/src/builders/cli/index.ts'),
        'doompi/dist/builders/cli/extensionAssembler/index': source(
          'packages/cli/doompi/src/builders/cli/extensionAssembler/index.ts',
        ),
        ...Object.fromEntries(
          [
            'agentModel',
            'composedPi',
            'contextCatalog',
            'cordisFinalizer',
            'cordisHost',
            'effort',
            'launcherBootstrap',
            'ollamaProvider',
            'styleSystem',
            'terminalChildSession',
            'transitionCoordinator',
          ].map((entry) => [
            `doompi/dist/extensions/${entry}`,
            source(`packages/cli/doompi/src/extensions/${entry}.ts`),
          ]),
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
