/** Hand-maintained declarations for scan.mjs; keep the two in step. */
export interface WebPluginManifestEntry {
  entry: string;
  specifier?: string;
}

export interface ScannedWebPlugin {
  pluginId: string;
  registrationOrder: number;
  dependencies: string[];
  channels: string[];
  packageDir: string;
  packageName: string;
  isHost: boolean;
  client: WebPluginManifestEntry;
  hub?: WebPluginManifestEntry;
}

export function findWorkspaceRoot(startDir: string): string | undefined;
export function scanWebPlugins(hostDir: string): ScannedWebPlugin[];
