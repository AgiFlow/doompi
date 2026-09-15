import { readPackageResource } from '../../../../../services/packageResources';

export default {
  name: 'doompi-model-guidance-readme',
  kind: 'context' as const,
  read: () => readPackageResource('README.md'),
};
