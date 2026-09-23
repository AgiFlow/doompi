import { defineResource } from '@agimon-ai/doompi-core/extensionFile';

import { PACKAGE_SOURCE, PROMPT_HELP_SKILL } from '../../../../../constants/prompt';
export default defineResource({ source: PACKAGE_SOURCE, moduleUrl: import.meta.url, skills: [PROMPT_HELP_SKILL] });
