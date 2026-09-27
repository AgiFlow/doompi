import type { CatalogTool } from '../mcpCatalog';

export type CountTokens = (text: string) => number;

/**
 * What one downstream tool would cost if it were added to the model's tool list directly: its
 * name, description and input schema, priced the way the context panel prices every other tool.
 */
export function mcpToolTokens(
  tool: Pick<CatalogTool, 'piName' | 'description' | 'inputSchema'>,
  countTokens: CountTokens,
): number {
  return countTokens(
    JSON.stringify({
      name: tool.piName,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.inputSchema,
    }),
  );
}
