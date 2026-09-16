import { defineWebLifecycle } from '@agimon-ai/doompi-core/web';

import { startAuthorBrowserLifecycle } from './_lib/authorBrowserLifecycle';

export default defineWebLifecycle(startAuthorBrowserLifecycle);
