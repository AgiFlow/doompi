import type { WebPluginDefinition } from '@agimon-ai/doompi-core/web';

import { computerUseSettingsSection } from '../_lib/computerUseSettings';

export default {
  settingsSections: [computerUseSettingsSection],
} satisfies NonNullable<WebPluginDefinition['global']>;
