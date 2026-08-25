import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import { SERVER_REGISTRY_FILE } from './webPluginGenerate.ts';
import { BUILTIN_HUB_CHANNELS } from './webHubPlugins.generated.ts';

interface RegistryEntry {
  pluginId?: unknown;
  hubEntry?: unknown;
}

const UNKNOWN_PLUGIN_ID = 'unknown';

/** The synced bundle's server registry, or an empty list when there is none to read. */
function registryEntries(assetsDir: string, onNotice: (message: string) => void): RegistryEntry[] {
  const registryPath = path.join(assetsDir, SERVER_REGISTRY_FILE);
  if (!fs.existsSync(registryPath)) return [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return Array.isArray(parsed) ? (parsed as RegistryEntry[]) : [];
  } catch (error) {
    onNotice(`web plugin registry ${registryPath} is unreadable (${String(error)}); plugin channels skipped`);
    return [];
  }
}

/**
 * Assembles the hub's data channels for the assets being served.
 *
 * A synced bundle carries webPlugins.server.json naming each plugin's built
 * hub entry by absolute path; those are imported lazily so an absent or
 * broken plugin package is a notice and an empty tab, never a crash. Without
 * a registry (the package's own prebuilt bundle, or a custom assets dir) the
 * built-in channels are the whole set.
 */
export async function loadHubChannels(
  assetsDir: string,
  onNotice: (message: string) => void,
): Promise<WebHubChannel[]> {
  const channels: WebHubChannel[] = [...BUILTIN_HUB_CHANNELS];
  for (const entry of registryEntries(assetsDir, onNotice)) {
    const pluginId = typeof entry.pluginId === 'string' ? entry.pluginId : UNKNOWN_PLUGIN_ID;
    if (typeof entry.hubEntry !== 'string') continue;
    try {
      const module = (await import(pathToFileURL(entry.hubEntry).href)) as { webHubChannels?: unknown };
      if (!Array.isArray(module.webHubChannels)) {
        throw new Error(`'${entry.hubEntry}' exports no webHubChannels array`);
      }
      channels.push(...(module.webHubChannels as WebHubChannel[]));
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      onNotice(`web plugin '${pluginId}' hub channels unavailable (${cause}); its panels stay empty`);
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
