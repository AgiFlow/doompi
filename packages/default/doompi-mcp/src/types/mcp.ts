import type { McpServerSnapshot, McpStatusSnapshot } from '@agimon-ai/doompi-extension-contracts/mcp-status';

/**
 * What the `/mcp` command needs from the session.
 *
 * Declared here rather than imported from the service so the command layer depends
 * on the behaviour it drives, not on how the runtime is put together.
 */
export interface McpCommandTarget {
  getSnapshot(): McpStatusSnapshot;
  getDiagnostics(): readonly string[];
  /** Reconnects a server, running its OAuth flow when it demands one. */
  reauthorize(serverName: string): Promise<void>;
  /** Rebuilds the runtime and reconnects everything. */
  start(): Promise<void>;
}

/** One tool as the overlay shows it, with the name its server knows it by. */
export interface McpServerToolView {
  piName: string;
  toolName: string;
  description?: string;
  /** False when a child agent's tool selection withholds it. */
  active: boolean;
}

/**
 * One resource a server offers.
 *
 * Declared structurally rather than re-exported from `@agimon-ai/mcp-proxy`, so a
 * proxy version bump cannot reshape what the UI layer is promised.
 */
export interface McpResourceView {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/**
 * One server as the overlay shows it.
 *
 * Richer than `McpServerSnapshot`, which carries only Pi tool names: the tools pane
 * needs the downstream name and description, and `toPiToolName` cannot be reversed
 * (`code-intel` and `code_intel` normalize to the same prefix). `enabled` is also
 * separate from `state` here, because a session disable is not a server transition.
 */
export interface McpServerView {
  name: string;
  /** The last transition the server actually reported, whatever `enabled` says. */
  state: McpServerSnapshot['state'];
  error?: string;
  tools: readonly McpServerToolView[];
  /** Resources counted the last time they were listed. Zero until the pane is opened. */
  resourceCount: number;
  enabled: boolean;
  /**
   * Authorization URL the user still has to open, while a flow is waiting on it.
   *
   * Carried on the view because the overlay is fullscreen: it supplies a compact
   * clickable fallback and lets `a` reopen the page without restarting the flow.
   */
  authorizationUrl?: string;
}

/** What the overlay needs from the session, on top of what the command needs. */
export interface McpOverlayTarget extends McpCommandTarget {
  getServers(): readonly McpServerView[];
  /** Session-only: hides or restores the server's tools. Never disconnects. */
  setEnabled(serverName: string, enabled: boolean): void;
  /** Opens the URL already reserved for a pending authorization without restarting it. */
  openAuthorizationPage(serverName: string): Promise<void>;
  /** Lists resources, from cache unless `refresh` asks for a fresh call. */
  listResources(serverName: string, options?: { refresh?: boolean }): Promise<readonly McpResourceView[]>;
  /** Fires whenever the server picture changes. Returns its own disposer. */
  onChange(listener: () => void): () => void;
}
