import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DOOM_MCP_BUNDLE_FILE,
  type DoomMcpBundle,
  type DoomMcpBundleEntry,
  parseDoomMcpBundle,
} from '../schemas/mcpBundle';
import type { DoomMcpPluginDefinition } from '../schemas/mcpFacet';

export interface LoadMcpBundleOptions {
  readonly directory: string;
  readonly generation: string;
  readonly fingerprint: string;
  /** SHA-256 of the descriptor bytes admitted by sync registration. */
  readonly descriptorSha256: string;
  readonly majorMode: string;
  readonly activeLayers: readonly string[];
  readonly onNotice?: (message: string) => void;
  /** Retain admitted candidates so a live session can follow selection changes. */
  readonly retainCandidates?: boolean;
}

export interface LoadedMcpPlugin {
  readonly declaration: DoomMcpBundleEntry;
  readonly plugin: DoomMcpPluginDefinition;
}

export interface LoadedMcpBundle {
  readonly descriptor: DoomMcpBundle;
  readonly plugins: readonly LoadedMcpPlugin[];
}

function containedFile(directory: string, relativeFile: string): string {
  const resolved = fs.realpathSync(path.resolve(directory, relativeFile));
  const relative = path.relative(directory, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error(`MCP bundle file escapes its generation: ${relativeFile}`);
  return resolved;
}

function isMcpPlugin(value: unknown): value is DoomMcpPluginDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DoomMcpPluginDefinition>;
  return (
    typeof candidate.name === 'string' &&
    (typeof candidate.session === 'function' || typeof candidate.session === 'object')
  );
}

/** Imports only modules named by an admitted MCP descriptor. */
export async function loadMcpBundle(options: LoadMcpBundleOptions): Promise<LoadedMcpBundle> {
  const directory = fs.realpathSync(options.directory);
  const descriptorBytes = fs.readFileSync(containedFile(directory, DOOM_MCP_BUNDLE_FILE));
  const descriptorSha256 = crypto.createHash('sha256').update(descriptorBytes).digest('hex');
  if (descriptorSha256 !== options.descriptorSha256)
    throw new Error('MCP descriptor hash does not match the admitted descriptor');
  const descriptor = parseDoomMcpBundle(JSON.parse(descriptorBytes.toString('utf8')));
  if (descriptor.generation !== options.generation || descriptor.fingerprint !== options.fingerprint)
    throw new Error('MCP bundle does not match the admitted generation');
  const plugins: LoadedMcpPlugin[] = [];
  for (const declaration of descriptor.entries) {
    const eligible = declaration.owners.some(
      (owner) =>
        owner.majorMode === options.majorMode &&
        (owner.layer === 'default' || options.activeLayers.includes(owner.layer)),
    );
    if (!eligible && options.retainCandidates !== true) continue;
    try {
      const file = containedFile(directory, declaration.module);
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (sha256 !== declaration.sha256) throw new Error('module hash does not match the admitted descriptor');
      const imported = (await import(pathToFileURL(file).href)) as { default?: unknown };
      if (!isMcpPlugin(imported.default)) throw new Error('default export is not an MCP plugin');
      plugins.push({ declaration, plugin: imported.default });
    } catch (error) {
      const message = `MCP plugin '${declaration.packageName}' could not load (${error instanceof Error ? error.message : String(error)})`;
      if (eligible) throw new Error(message, { cause: error });
      options.onNotice?.(message);
    }
  }
  return { descriptor, plugins };
}
