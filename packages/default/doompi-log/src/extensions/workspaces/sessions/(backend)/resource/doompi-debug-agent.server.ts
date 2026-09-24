import { defineResource } from '@agimon-ai/doompi-core/extensionFile';
import { DOOM_HELP_WHEN as HELP_WHEN } from '@agimon-ai/doompi-core/help';
import { packageResourcePath, readPackageResource } from '@agimon-ai/doompi-core/serverFacet';

import { AGENT_DIAGNOSTIC_SKILL } from '../../../../../constants/diagnostics';

export default defineResource({
  ...AGENT_DIAGNOSTIC_SKILL,
  when: HELP_WHEN,
  kind: 'skill' as const,
  path: packageResourcePath(import.meta.url, 'src/prompts/doompi-debug-agent/SKILL.md'),
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-debug-agent/SKILL.md'),
});
