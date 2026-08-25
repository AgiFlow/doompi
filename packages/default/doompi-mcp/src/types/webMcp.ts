/**
 * What an MCP tool result carries beyond its text, shared by this package's
 * Pi adapter (which attaches it as the result's details) and its web plugin
 * (which renders it). Wire JSON only: images ride Pi's own content blocks,
 * so they are not repeated here.
 */

export type McpResultBlock =
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; title?: string; description?: string; mimeType?: string }
  | { type: 'resource'; uri: string; mimeType?: string; text?: string; blob?: string }
  | { type: 'structured'; value: Record<string, unknown> };

export interface McpToolDetails {
  server: string;
  tool: string;
  /** Present only when the downstream result carried something beyond text and images. */
  blocks?: McpResultBlock[];
}
