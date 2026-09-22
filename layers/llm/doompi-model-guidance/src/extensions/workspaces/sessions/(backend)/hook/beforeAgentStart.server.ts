import { defineHook } from '@agimon-ai/doompi-core/extensionFile';

import contribution from './_lib/beforeAgentStart.server';

export default defineHook(contribution);
