import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    '*': 'src/exports/**/*.ts',
    // Child-process entries: private artifacts the runtime spawns, not exports.
    'extensions/subagentPromptRuntimeEntry': 'src/adapters/pi/extensions/subagentPromptRuntimeEntry.cts',
    'runs/sdkRunnerEntry': 'src/adapters/process/sdkRunnerEntry.ts',
    'runs/background/cliRunnerEntry': 'src/adapters/runs/background/cliRunnerEntry.ts',
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
