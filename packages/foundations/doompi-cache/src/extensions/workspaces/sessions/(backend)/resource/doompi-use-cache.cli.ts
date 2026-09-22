import { defineResource } from '@agimon-ai/doompi-core/extensionFile';

import { CACHE_HELP_SKILL, PACKAGE_SOURCE } from '../../../../../constants/cache';
export default defineResource({ source: PACKAGE_SOURCE, moduleUrl: import.meta.url, skills: [CACHE_HELP_SKILL] });
