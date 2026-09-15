import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import contribution from './_lib/subagents-steer.cli';

export default defineRoutedContribution(contribution, {});
