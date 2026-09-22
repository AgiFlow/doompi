import { defineMessageRenderer } from '@agimon-ai/doompi-core/piExtension';

import contribution from './_lib/subagent-notify.cli';

export default defineMessageRenderer(...contribution);
