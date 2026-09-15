import { defineResource } from '@agimon-ai/doompi-core/extension-file';

export default defineResource({
  source: '@agimon-ai/doompi-mcp',
  moduleUrl: import.meta.url,
  skills: [
    {
      name: 'doompi-use-mcp',
      description:
        'Use Doom Pi MCP to inspect domain-scoped servers, authenticate, reload configuration, and troubleshoot tool availability.',
    },
  ],
});
