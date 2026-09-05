import { defineConfig } from 'tsdown';

export default defineConfig({
  // webClient.ts re-exports the browser half; the cockpit bundles it from
  // source, so node-building it here would pull React into dist for nothing.
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
