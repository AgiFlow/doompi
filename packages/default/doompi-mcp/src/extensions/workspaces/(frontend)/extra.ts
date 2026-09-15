import type { WebPluginDefinition } from '@agimon-ai/doompi-core/web';

import { McpRepositorySettingsPanel } from '../../../web/components/McpRepositorySettingsPanel';
export default {
  repositorySettingsPanel: {
    label: 'MCP servers',
    detail: 'inspect cached capabilities, discover live servers, and complete OAuth authorization.',
    order: 100,
    component: McpRepositorySettingsPanel,
  },
} satisfies NonNullable<WebPluginDefinition['workspace']>;
