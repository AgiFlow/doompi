import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import { bindMcpSkills } from '../../../../../services/mcpSkills';

export default defineRoutedContribution(bindMcpSkills, { cardinality: 'many' });
