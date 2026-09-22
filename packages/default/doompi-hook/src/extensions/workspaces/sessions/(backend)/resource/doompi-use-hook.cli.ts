import { defineResource } from '@agimon-ai/doompi-core/extensionFile';

import { HOOK_HELP_SKILL, PACKAGE_SOURCE } from '../../../../../constants/hook';
export default defineResource({ source: PACKAGE_SOURCE, moduleUrl: import.meta.url, skills: [HOOK_HELP_SKILL] });
