import { defineHook } from '@agimon-ai/doompi-core/extension-file';

import { cacheHooks } from '../_lib/cacheHooks';
export default defineHook(cacheHooks.find((hook) => hook.event === 'before_provider_request')!);
