import type { WebPluginDefinition } from '@agimon-ai/doompi-core/web';

import { voiceSettingsSection } from '../../web/lib/voiceSettings';

export default { settingsSections: [voiceSettingsSection] } satisfies NonNullable<WebPluginDefinition['global']>;
