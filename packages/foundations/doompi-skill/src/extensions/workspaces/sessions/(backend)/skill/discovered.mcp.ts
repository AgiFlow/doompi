import { defineRoutedContribution } from '@agimon-ai/doompi-core/extensionFile';

import { bindMcpSkills } from '../../../../../services/mcpSkills';

export default defineRoutedContribution(bindMcpSkills, { cardinality: 'many' });
