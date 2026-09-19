import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineMcpSkill({
  name: 'doompi-author-major-mode',
  description:
    "Configure DoomPi default packages, layers, extensions, hook groups, and named major modes. Use when creating or editing ~/.pi/.doom/modes.yaml or a repository's .doom/modes.yaml, choosing a default mode, or diagnosing which behavior a mode activates.",
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-author-major-mode/SKILL.md'),
});
