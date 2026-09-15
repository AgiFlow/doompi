import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

/**
 * The whole build. Entries come from the folder tree under src/extensions,
 * and the host entries this package publishes are written to generated/.
 */
export default defineConfig(
  // The cockpit keys this package's tab, its subagents.run-actions slot and
  // its leader bindings on 'subagents', so the id does not follow the package
  // name and deriving it would rename all three.
  doompiExtension({
    packageDir: process.cwd(),
    pluginId: 'subagents',
    // Private child-process artifact spawned by the external runtime host.
    entry: { 'runs/background/cliRunnerEntry': 'src/bin/cliRunner.ts' },
  }),
);
