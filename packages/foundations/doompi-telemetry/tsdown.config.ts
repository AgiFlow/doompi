import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { '*': 'src/exports/**/*.ts' },
  clean: true,
  dts: { incremental: true, parallel: false, eager: true },
  exports: false,
  format: ['esm', 'cjs'],
  minify: {
    compress: true,
    mangle: { toplevel: true },
    codegen: { removeWhitespace: true },
  },
  // Retained runner resources copy this dist graph without an npm dependency tree.
  deps: {
    alwaysBundle: ['@agimon-ai/log-sink-mcp/telemetry/node'],
    dts: { neverBundle: ['@agimon-ai/log-sink-mcp/telemetry/node'] },
  },
  platform: 'node',
  sourcemap: true,
  unbundle: false,
});
