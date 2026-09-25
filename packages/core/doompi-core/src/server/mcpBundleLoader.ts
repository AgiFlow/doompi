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
import type { DoomMcpPluginDefinition, DoomMcpUiResource } from '../schemas/mcpFacet';

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
  let resource: DoomMcpUiResource | undefined;
  if (descriptor.ui) {
    const html = fs.readFileSync(containedFile(directory, descriptor.ui.file), 'utf8');
    if (crypto.createHash('sha256').update(html).digest('hex') !== descriptor.ui.sha256)
      throw new Error('MCP UI hash does not match the admitted descriptor');
    resource = {
      uri: `ui://doompi/tools/${descriptor.ui.sha256}/index.html`,
      name: 'doompi-tool-widgets',
      description: 'Package-owned tool widgets composed by doompi sync.',
      mimeType: 'text/html;profile=mcp-app',
      _meta: {
        ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
        'openai/widgetPrefersBorder': true,
        'openai/widgetCSP': { connect_domains: [], resource_domains: [] },
      },
      read: () => html,
    };
  }
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
      const original = imported.default;
      const ui = resource;
      const allowedWidgets = new Set(declaration.widgets ?? []);
      const plugin: DoomMcpPluginDefinition =
        ui === undefined || allowedWidgets.size === 0
          ? original
          : {
              ...original,
              async session(context) {
                const scope =
                  typeof original.session === 'function' ? await original.session(context) : original.session;
                const { tools: contributedTools, uiResources: contributedResources, ...rest } = scope;
                let usesWidget = false;
                const tools = contributedTools?.map((tool) => {
                  const widget = tool._meta?.['doompi/widget'];
                  if (widget === undefined) return tool;
                  if (typeof widget !== 'string' || !allowedWidgets.has(widget))
                    throw new Error(`MCP tool '${tool.name}' references a widget not owned by its package`);
                  usesWidget = true;
                  return {
                    ...tool,
                    _meta: {
                      ...tool._meta,
                      ui: {
                        ...tool._meta?.ui,
                        resourceUri: ui.uri,
                        visibility: tool._meta?.ui?.visibility ?? ['model'],
                      },
                      'openai/outputTemplate': ui.uri,
                    },
                  };
                });
                return {
                  ...rest,
                  ...(tools === undefined ? {} : { tools }),
                  uiResources: [...(contributedResources ?? []), ...(usesWidget ? [ui] : [])],
                };
              },
            };
      plugins.push({ declaration, plugin });
    } catch (error) {
      const message = `MCP plugin '${declaration.packageName}' could not load (${error instanceof Error ? error.message : String(error)})`;
      if (eligible) throw new Error(message, { cause: error });
      options.onNotice?.(message);
    }
  }
  return { descriptor, plugins };
}
