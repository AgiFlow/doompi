import { defineCliHook } from '@agimon-ai/doompi-core/extensionFile';

import contribution from './_lib/before-agent-start.cli';

export default defineCliHook(contribution);
