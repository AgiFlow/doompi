import { defineConfig } from 'tsdown';

export default defineConfig({
  // The web client is shipped as source and compiled into the cockpit bundle,
  // so this node build must not try to bundle React for a browser entry.
  entry: { '*': ['src/exports/**/*.ts', '!src/exports/webClient.ts'] },
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
