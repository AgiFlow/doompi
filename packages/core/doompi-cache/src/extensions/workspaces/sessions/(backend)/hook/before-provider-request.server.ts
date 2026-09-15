import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import { cacheHooks } from '../_lib/cacheHooks';
export default defineRoutedContribution(
  cacheHooks.find((hook) => hook.event === 'before_provider_request')!,
  {},
);
