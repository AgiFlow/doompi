import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Display name for an extension that Pi could not attribute to a package.
 *
 * Pi stamps every `--extension <path>` argument with the literal source `cli`,
 * and doom-pi launches all of its extensions that way, so the only surviving
 * identity is the entry path. The nearest `package.json` above it names the
 * package that registered the tools.
 */

/** Results are stable for the life of a session, and every source hits the same few dirs. */
const cache = new Map<string, string>();
const TOOL_SOURCE_REGISTRY_KEY = '__doompiExtensionToolSources__' as const;

type RegisteredTool = Parameters<ExtensionAPI['registerTool']>[0];
interface ToolSourceMetadata {
  readonly entryPath: string;
}
type RegistryHost = ExtensionAPI & { [TOOL_SOURCE_REGISTRY_KEY]?: Map<string, ToolSourceMetadata> };

/** Session-local provenance attached to Pi's API rather than process-global state. */
function toolSourceRegistry(pi: ExtensionAPI): Map<string, ToolSourceMetadata> {
  const host = pi as RegistryHost;
  const existing = host[TOOL_SOURCE_REGISTRY_KEY];
  if (existing) return existing;
  const registry = new Map<string, ToolSourceMetadata>();
  Object.defineProperty(host, TOOL_SOURCE_REGISTRY_KEY, {
    configurable: false,
    enumerable: false,
    value: registry,
    writable: false,
  });
  return registry;
}

function boundValue(target: object, property: PropertyKey): unknown {
  const value = Reflect.get(target, property, target);
  return typeof value === 'function' ? value.bind(target) : value;
}

/**
 * Gives one composed extension a Pi API that remembers which tools it registers.
 *
 * Pi attributes every factory inside a compiled Doom bundle to the outer bundle.
 * The compiler still knows each original entry path, so it calls factories through
 * this boundary and preserves that identity before the information is lost.
 */
export function withExtensionSource(pi: ExtensionAPI, entryPath: string): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property) {
      if (property !== 'registerTool') return boundValue(target, property);
      return (tool: RegisteredTool): void => {
        target.registerTool(tool);
        toolSourceRegistry(target).set(tool.name, Object.freeze({ entryPath }));
      };
    },
  });
}

/** Original extension entry that registered a tool inside a composed bundle. */
export function extensionToolSource(pi: ExtensionAPI, toolName: string): string | undefined {
  return toolSourceRegistry(pi).get(toolName)?.entryPath;
}

function packageName(directory: string): string | undefined {
  let current = directory;
  for (;;) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8')) as { name?: unknown };
      if (typeof manifest.name === 'string' && manifest.name.length > 0) return manifest.name;
    } catch {
      // No manifest here, or an unreadable one; keep walking up.
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function extensionName(entryPath: string): string {
  const cached = cache.get(entryPath);
  if (cached !== undefined) return cached;
  const name = packageName(path.dirname(entryPath));
  // `@agimon-ai/doompi-task` reads as `doom-task`; the scope is noise in a tree.
  const resolved = name ? (name.split('/').pop() ?? name) : path.basename(entryPath, path.extname(entryPath));
  cache.set(entryPath, resolved);
  return resolved;
}
