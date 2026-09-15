import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const routed = doompiExtension({
  packageDir: process.cwd(),
  exportsDir: 'src/exports/_none',
  entry: {
    'api-contracts': 'src/exports/apiContracts.ts',
    index: 'src/exports/index.ts',
    config: 'src/exports/config.ts',
    'fable-flow': 'src/exports/fableFlow.ts',
    'log-sink-telemetry': 'src/exports/logSinkTelemetry.ts',
    'plan-config': 'src/exports/planConfig.ts',
    'plan-mode': 'src/exports/planMode.ts',
    prompts: 'src/exports/prompts.ts',
  },
});
if (!Array.isArray(routed)) throw new Error('plan requires its web bundle.');

export default defineConfig([{ ...routed[0], exports: false }, routed[1]]);
