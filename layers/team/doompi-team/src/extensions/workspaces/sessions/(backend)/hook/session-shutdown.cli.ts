import { defineCliHook } from '@agimon-ai/doompi-core/extensionFile';

import contribution from './_lib/session-shutdown.cli';

export default defineCliHook(contribution);
