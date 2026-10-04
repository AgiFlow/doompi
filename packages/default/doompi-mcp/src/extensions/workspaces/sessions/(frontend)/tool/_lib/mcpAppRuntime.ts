import { defineSessionStore, type WebPluginRuntime } from '@agimon-ai/doompi-core/web';

export type { McpAppOpenResult } from '../../../../../../types/webMcp';

interface AppRuntimeBinding {
  runtime: WebPluginRuntime | null;
}

export const mcpAppRuntime = defineSessionStore<AppRuntimeBinding>({ runtime: null });

/** Session mount lifecycle owns the authenticated RPC capability and drops it on unload. */
export function startMcpAppRuntime(runtime: WebPluginRuntime): () => void {
  const mount = runtime.mount;
  if (mount?.scope !== 'session') throw new Error('MCP Apps require a session runtime mount');
  mcpAppRuntime.update(mount.sessionId, () => ({ runtime }));
  return () => {
    if (mcpAppRuntime.select(mcpAppRuntime.store.state, mount.sessionId).runtime === runtime) {
      mcpAppRuntime.drop(mount.sessionId);
    }
  };
}
