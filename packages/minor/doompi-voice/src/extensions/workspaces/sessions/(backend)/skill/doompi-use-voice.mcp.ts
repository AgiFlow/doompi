import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineMcpSkill({
  name: 'doompi-use-voice',
  description:
    'Use Doom Pi Voice for manual transcription, autonomous capture, narration, configuration, and recovery on macOS.',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-voice/SKILL.md'),
});
