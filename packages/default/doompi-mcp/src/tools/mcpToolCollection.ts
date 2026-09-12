import type { PiToolCollection, PiToolDeclaration } from '@agimon-ai/doompi-extension-contracts/pi-extension';
import type { McpSession } from '../services/mcpSession';
import type { CatalogTool } from '../services/mcpCatalog';
import { createMcpTool, type McpToolRenderers } from './mcpTools';
export function createMcpToolCollection(
  session: McpSession,
  renderers: (tool: CatalogTool) => McpToolRenderers = () => ({}),
): PiToolCollection {
  const declarations = new Map<CatalogTool, PiToolDeclaration>();
  return {
    snapshot: (): readonly PiToolDeclaration[] =>
      session.toolDefinitions().map((tool) => {
        let declaration = declarations.get(tool);
        if (!declaration) {
          declaration = createMcpTool(
            session.getClientManager,
            tool,
            (candidate) => session.isToolAvailable(candidate),
            renderers(tool),
          );
          declarations.set(tool, declaration);
        }
        return declaration;
      }),
    subscribe: (listener: () => void) => session.onChange(listener),
  };
}
