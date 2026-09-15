import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import { startAuthorBrowserLifecycle } from '../../../../../web/hooks/authorBrowserLifecycle';

export default defineRoutedContribution(startAuthorBrowserLifecycle, {});
