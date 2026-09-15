import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

export default defineConfig(
  doompiExtension({
    packageDir: process.cwd(),
    entry: {
      'bin/cli': 'src/bin/cli.ts',
      'bin/logSink': 'src/bin/logSink.ts',
      'bin/runnerHost': 'src/bin/runnerHost.ts',
    },
  }),
);
