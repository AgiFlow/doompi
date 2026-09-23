import { defineMessageRenderer } from '@agimon-ai/doompi-core/piExtension';

import contribution from './_lib/intercom-message.cli';

export default defineMessageRenderer(...contribution);
