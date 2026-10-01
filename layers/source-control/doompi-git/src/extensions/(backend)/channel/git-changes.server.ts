import { defineChannel } from '@agimon-ai/doompi-core/extensionFile';

import contribution from './_lib/git-changes.server';

export default defineChannel(contribution);
