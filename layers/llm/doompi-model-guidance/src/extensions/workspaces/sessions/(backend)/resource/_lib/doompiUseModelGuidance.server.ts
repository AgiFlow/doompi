import { readPackageResource } from '../../../../../../services/packageResources';

export default {
  name: 'doompi-use-model-guidance',
  kind: 'skill' as const,
  read: () => readPackageResource('src/prompts/doompi-use-model-guidance/SKILL.md'),
};
