import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import contribution from './_lib/beforeAgentStart.cli';

export default defineRoutedContribution(contribution, {});
