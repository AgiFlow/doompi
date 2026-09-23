import { defineCliHook } from '@agimon-ai/doompi-core/extensionFile';

import contribution from './_lib/beforeAgentStart.cli';

export default defineCliHook(contribution);
