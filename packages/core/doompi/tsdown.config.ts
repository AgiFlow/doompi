import { defineConfig } from 'tsdown';

// Public entries mirror package exports. Internal dynamic entrypoints are
// listed explicitly as well so a source import cannot point outside the tarball.

const output = {
  exports: false,
  format: ['esm', 'cjs'] as ('esm' | 'cjs')[],
  minify: {
    compress: true,
    mangle: { toplevel: true },
    codegen: { removeWhitespace: true },
  },
  platform: 'node' as const,
  sourcemap: true,
};

export default defineConfig({
  ...output,
  name: 'package',
  entry: {
    '*': 'src/exports/**/*.ts',
    // Executables and dynamically imported private modules keep their own
    // entries: a facade would re-export them instead of running them, and the
    // tarball has to contain every module a source import can reach.
    'bin/cli': 'src/bin/cli.ts',
    'bin/doomRunner': 'src/bin/doomRunner.ts',
    'bin/dpi': 'src/bin/dpi.ts',
    // Keyed with the src/ prefix on purpose. Unbundled chunks are emitted
    // under dist/src, and ownEntry() locates sibling entries relative to its
    // own compiled path, so an entry keyed without the prefix lands outside
    // the directory the runtime looks in.
    'src/adapters/syncedRuntimeBuilder': 'src/adapters/syncedRuntimeBuilder.ts',
    'src/extensions/entries/transitionCoordinator': 'src/extensions/entries/transitionCoordinator.ts',
    'src/services/extensionAssembler': 'src/services/extensionAssembler.ts',
  },
  clean: true,
  dts: { incremental: true, parallel: false, eager: true },
  unbundle: true,
});
