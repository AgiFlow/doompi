import type { WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import { BUILTIN_HUB_CHANNELS, EXTERNAL_HUB_PLUGINS } from './webHubPlugins.generated.ts';

/**
 * Assembles the hub's data channels: built-ins statically, external plugin
 * packages by dynamic import (the same lazy-import posture doompi-server
 * takes toward this package). An absent or broken plugin package is a notice
 * and an empty tab, never a crash; the client tab is always compiled in, so
 * its empty state is what the user sees.
 */
export async function loadHubChannels(onNotice: (message: string) => void): Promise<WebHubChannel[]> {
  const channels: WebHubChannel[] = [...BUILTIN_HUB_CHANNELS];
  for (const plugin of EXTERNAL_HUB_PLUGINS) {
    try {
      const module = (await import(plugin.specifier)) as { webHubChannels?: unknown };
      if (!Array.isArray(module.webHubChannels)) {
        throw new Error(`'${plugin.specifier}' exports no webHubChannels array`);
      }
      channels.push(...(module.webHubChannels as WebHubChannel[]));
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      onNotice(`web plugin '${plugin.pluginId}' hub channels unavailable (${cause}); its panels stay empty`);
    }
  }
  const seen = new Set<string>();
  const unique: WebHubChannel[] = [];
  for (const channel of channels) {
    if (seen.has(channel.frameType)) {
      onNotice(`duplicate web channel '${channel.frameType}' dropped; frame types are global`);
      continue;
    }
    seen.add(channel.frameType);
    unique.push(channel);
  }
  return unique;
}
