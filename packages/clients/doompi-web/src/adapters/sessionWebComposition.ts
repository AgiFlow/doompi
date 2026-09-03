import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readSyncRegistration } from '@agimon-ai/doompi/services';

const CLIENT_ENTRY = 'composition.js';
const VITE_MANIFEST = 'manifest.json';

export interface SessionWebArtifacts {
  id: string;
  pluginsDir: string;
  entryPath: string;
  stylePaths: string[];
}

interface ViteManifestEntry {
  file?: unknown;
  isEntry?: unknown;
  css?: unknown;
}

function stylePaths(manifestPath: string): string[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const entries = Object.values(parsed as Record<string, ViteManifestEntry>);
  const entry = entries.find((candidate) => candidate.isEntry === true && candidate.file === CLIENT_ENTRY);
  const styles = [
    ...(entry !== undefined && Array.isArray(entry.css) ? entry.css : []),
    ...entries.map((candidate) => candidate.file).filter((file) => typeof file === 'string' && file.endsWith('.css')),
  ];
  return [...new Set(styles)]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .map((value) => `/${value.replace(/^\/+/, '')}`);
}

/** Resolves the immutable standalone plugin artifacts emitted by the root's latest sync. */
export function resolveSessionWebArtifacts(configurationRoot: string): SessionWebArtifacts | undefined {
  const registration = readSyncRegistration(configurationRoot);
  if (registration?.webDirectory === null || registration?.webDirectory === undefined) return undefined;
  const pluginsDir = path.join(path.dirname(registration.webDirectory), 'plugins');
  const entryFile = path.join(pluginsDir, CLIENT_ENTRY);
  const manifestFile = path.join(pluginsDir, VITE_MANIFEST);
  if (!fs.existsSync(entryFile) || !fs.existsSync(manifestFile)) return undefined;
  const id = createHash('sha256')
    .update(
      JSON.stringify({
        root: registration.root,
        generation: registration.generation,
        stateSha256: registration.stateSha256,
      }),
    )
    .digest('hex');
  return {
    id,
    pluginsDir,
    entryPath: `/${CLIENT_ENTRY}`,
    stylePaths: stylePaths(manifestFile),
  };
}
