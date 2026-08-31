// @scaffold-generated
import { defineConfig } from 'tsdown';

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
  deps: {
    // Pi Server invokes Pi Protocol's hot-path validators. Bundle both so the
    // published executable retains our patched protocol codec.
    alwaysBundle: [/^@earendil-works\/pi-(?:protocol|server)(?:\/|$)/u],
  },
  unbundle: false,
});
