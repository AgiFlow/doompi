import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const routed = doompiExtension({
  packageDir: process.cwd(),
  entry: {
    'bin/cli': 'src/bin/cli.ts',
    'bin/logSink': 'src/bin/logSink.ts',
    'bin/runnerHost': 'src/bin/runnerHost.ts',
    'services/lifeline/client': 'src/services/lifeline/client.ts',
    'services/runnerSupervisor/index': 'src/services/runnerSupervisor/index.ts',
  },
});
if (!Array.isArray(routed)) throw new Error('Runner requires its web bundle.');

export default defineConfig([
  {
    ...routed[0],
    exports: { exclude: ['services/lifeline/client', 'services/runnerSupervisor/index'] },
  },
  routed[1],
]);
