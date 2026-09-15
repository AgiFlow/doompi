import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

/**
 * The whole build. Entries come from the folder tree under src/extensions,
 * and the host entries this package publishes are written to generated/.
 */
export default defineConfig(doompiExtension());
