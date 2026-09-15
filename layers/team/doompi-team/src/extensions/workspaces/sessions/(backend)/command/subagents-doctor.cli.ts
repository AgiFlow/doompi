import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import contribution from './_lib/subagents-doctor.cli';

export default defineRoutedContribution(contribution, {});
