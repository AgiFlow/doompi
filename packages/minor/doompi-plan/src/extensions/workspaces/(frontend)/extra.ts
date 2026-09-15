import type { WebPluginDefinition } from '@agimon-ai/doompi-core/web';

import { planSettingsSection } from '../../../web/lib/planSettings';

export default {
  // The same five fields the TUI's SPC e c panel draws, from one descriptor
  // table; the host renders them and owns which config file an edit lands in.
  settingsSections: [planSettingsSection],
} satisfies NonNullable<WebPluginDefinition['workspace']>;
