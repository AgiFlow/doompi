import type { DoomMcpWidgetProps } from '../types/mcpWidget';

/** Types one package-owned MCP widget without coupling the route to the composed host. */
export function defineMcpWidget<T extends (props: DoomMcpWidgetProps) => unknown>(widget: T): T {
  return widget;
}
