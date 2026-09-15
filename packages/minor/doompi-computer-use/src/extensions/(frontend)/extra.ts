import type { WebPluginDefinition } from '@agimon-ai/doompi-core/web';

import { computerUseSettingsSection } from '../../web/lib/computerUseSettings';

export default {
  settingsSections: [computerUseSettingsSection],
} satisfies NonNullable<WebPluginDefinition['global']>;
