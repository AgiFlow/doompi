import { defineWebLifecycle } from '@agimon-ai/doompi-core/web';

import { startAuthorBrowserLifecycle } from '../../../../../web/hooks/authorBrowserLifecycle';

export default defineWebLifecycle(startAuthorBrowserLifecycle);
