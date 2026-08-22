const SELECTOR_SEPARATOR = '/';

/**
 * Which downstream tools a child may see.
 *
 * A selector is either a whole server (`pencil`) or one tool of it
 * (`pencil/get_screenshot`).
 */
export class DirectToolFilter {
  private readonly servers = new Set<string>();
  private readonly tools = new Map<string, Set<string>>();

  constructor(selectors: readonly string[]) {
    for (const raw of selectors) {
      const selector = raw.trim().replace(/\/+$/, '');
      if (!selector) continue;
      const separator = selector.indexOf(SELECTOR_SEPARATOR);
      if (separator === -1) {
        this.servers.add(selector);
        continue;
      }
      const server = selector.slice(0, separator);
      const tool = selector.slice(separator + 1);
      if (!server) continue;
      if (!tool) {
        this.servers.add(server);
        continue;
      }
      const selected = this.tools.get(server) ?? new Set<string>();
      selected.add(tool);
      this.tools.set(server, selected);
    }
  }

  allows(serverName: string, toolName: string): boolean {
    if (this.servers.has(serverName)) return true;
    return this.tools.get(serverName)?.has(toolName) ?? false;
  }
}
