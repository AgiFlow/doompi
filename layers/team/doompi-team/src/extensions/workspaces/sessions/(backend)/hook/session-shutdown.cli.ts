import { defineCliHook } from '@agimon-ai/doompi-core/extension-file';

import contribution from './_lib/session-shutdown.cli';

export default defineCliHook(contribution);
