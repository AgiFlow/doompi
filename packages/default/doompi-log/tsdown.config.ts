import { defineConfig } from 'tsdown';

export default defineConfig({
  // The web client is shipped as source and compiled into the cockpit bundle,
  // so this node build must not try to bundle React for a browser entry.
  entry: {
    'api-contracts': 'src/exports/apiContracts.ts',
    index: 'src/exports/index.ts',
    metrics: 'src/exports/metrics.ts',
    metricsSource: 'src/exports/metricsSource.ts',
    'metrics-overlay': 'src/exports/metricsOverlay.ts',
    'extensions/pi': 'src/extensions/pi.ts',
    'extensions/server': 'src/extensions/server.ts',
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
