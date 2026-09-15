import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import contribution from './_lib/session-shutdown.server';

export default defineRoutedContribution(contribution, {});
