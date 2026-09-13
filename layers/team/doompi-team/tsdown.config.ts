import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    'api-contracts': 'src/exports/apiContracts.ts',
    'fable-plan-api': 'src/schemas/fablePlanApi.ts',
    'runtime-subagent-policy': 'src/schemas/subagentPolicy.ts',
    'runtime-subagent-tool': 'src/schemas/subagentTool.ts',
    'delegation-api': 'src/exports/delegationApi.ts',
    'fable-plan': 'src/exports/fablePlanApi.ts',
    'subagent-policy': 'src/exports/subagentPolicy.ts',
    'subagent-tool': 'src/exports/subagentTool.ts',
    delegation: 'src/exports/delegation.ts',
    capabilityCeiling: 'src/exports/capabilityCeiling.ts',
    index: 'src/exports/index.ts',
    env: 'src/exports/env.ts',
    teamSnapshot: 'src/exports/teamSnapshot.ts',
    'extensions/pi': 'src/extensions/pi.ts',
    'extensions/server': 'src/extensions/server.ts',
    'runs/background/cliRunnerEntry': 'src/bin/cliRunner.ts',
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
