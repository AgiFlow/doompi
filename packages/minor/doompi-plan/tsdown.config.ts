import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    'api-contracts': 'src/exports/apiContracts.ts',
    index: 'src/exports/index.ts',
    'extensions/pi': 'src/extensions/pi.ts',
    'extensions/server': 'src/extensions/server.ts',
    config: 'src/exports/config.ts',
    'fable-flow': 'src/exports/fableFlow.ts',
    'log-sink-telemetry': 'src/exports/logSinkTelemetry.ts',
    'plan-config': 'src/exports/planConfig.ts',
    'plan-mode': 'src/exports/planMode.ts',
    prompts: 'src/exports/prompts.ts',
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
