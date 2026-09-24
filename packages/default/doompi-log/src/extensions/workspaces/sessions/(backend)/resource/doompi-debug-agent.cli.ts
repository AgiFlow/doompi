import { defineResource } from '@agimon-ai/doompi-core/extensionFile';

import { AGENT_DIAGNOSTIC_SKILL } from '../../../../../constants/diagnostics';
import { PACKAGE_NAME } from '../../../../../constants/telemetry';

export default defineResource({ source: PACKAGE_NAME, moduleUrl: import.meta.url, skills: [AGENT_DIAGNOSTIC_SKILL] });
