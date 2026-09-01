import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    '*': ['src/exports/**/*.ts', '!src/exports/webClient.ts'],
    voiceWorker: 'src/adapters/process/voiceWorker.ts',
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
