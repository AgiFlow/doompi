import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import { McpRepositorySettingsPanel } from '../../../../web/components/McpRepositorySettingsPanel';
export default defineRoutedContribution(
  {
    label: 'MCP servers',
    detail: 'inspect cached capabilities, discover live servers, and complete OAuth authorization.',
    order: 100,
    component: McpRepositorySettingsPanel,
  },
  {},
);
