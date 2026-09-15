import type { WebPluginDefinition } from '@agimon-ai/doompi-core/web';

import { autocompactSettingsSection } from '../../../web/lib/autocompactSettings';

export default {
  settingsSections: [autocompactSettingsSection],
} satisfies NonNullable<WebPluginDefinition['workspace']>;
