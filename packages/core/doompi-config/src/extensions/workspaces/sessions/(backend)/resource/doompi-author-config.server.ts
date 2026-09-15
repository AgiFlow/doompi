import { readPackageResource } from '../../../../services/configResources';
export default { name: 'doompi-author-config', kind: 'skill' as const, read: () => readPackageResource('src/prompts/doompi-author-config/SKILL.md') };
