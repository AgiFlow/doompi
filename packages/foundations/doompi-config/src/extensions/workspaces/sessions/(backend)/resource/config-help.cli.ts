import { defineResource } from '@agimon-ai/doompi-core/extensionFile';

import { CONFIG_HELP_SKILL, PACKAGE_SOURCE } from '../../../../../constants/config';
export default defineResource({ source: PACKAGE_SOURCE, moduleUrl: import.meta.url, skills: [CONFIG_HELP_SKILL] });
