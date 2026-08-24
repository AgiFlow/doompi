import { defineConfig } from 'tsdown';
import { ensureWebPluginModules } from './scripts/webPlugins/generate.mjs';

// Both build halves refresh the generated plugin registry at config load; CI
// only checks, so a stale committed registry fails the build loudly.
ensureWebPluginModules({ check: Boolean(process.env.CI) });

export default defineConfig({
  entry: {
    '*': 'src/exports/**/*.ts',
    // The executable keeps its own entry: a re-export would load it instead of
    // running it.
    'bin/serve': 'src/bin/serve.ts',
  },
  clean: true,
  dts: { incremental: true, parallel: false, eager: true },
  exports: false,
  format: ['esm', 'cjs'],
  minify: {
    compress: true,
    mangle: { toplevel: true },
    codegen: { removeWhitespace: true },
  },
  platform: 'node',
  sourcemap: true,
  unbundle: true,
});
