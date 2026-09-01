import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { autocompactSettingsSection } from './autocompactSettings.ts';

/**
 * This package's cockpit presence: one settings page.
 *
 * Compaction itself is a background pass with a footer status the session
 * already publishes, so there is nothing to render in the timeline. What a
 * reader cannot otherwise reach is which model summarizes and when the ladder
 * fires, which is exactly what these fields write.
 */
export const webPlugin = defineWebPlugin({
  id: 'autocompact',
  settingsSections: [autocompactSettingsSection],
});
