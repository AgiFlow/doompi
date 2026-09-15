import { readPackageResource } from '../../../../../../services/packageResources';

export default {
  name: 'doompi-model-guidance',
  kind: 'context' as const,
  read: () => readPackageResource('llms.txt'),
};
