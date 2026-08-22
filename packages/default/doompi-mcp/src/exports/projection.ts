export { AGENT_PLUGIN_MCP_SCHEMA_URL } from '@agimon-ai/doompi-extension-contracts/mcp-projection';
export {
  normalizeAgentPluginMcpSource,
  type NormalizeAgentPluginMcpOptions,
  type NormalizedAgentPluginMcpSource,
} from '@agimon-ai/doompi-config/agentPluginMcp';
export { mcpSessionConfigFromProjection } from '../adapters/node/projection.ts';
export type { McpConfigSource, McpSessionConfig } from '../types/mcpConfig.ts';
