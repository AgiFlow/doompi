import { resolvePluginEntries } from '@agimon-ai/doompi-config/domains';
import { getHarnessState, harnessRoot } from '@agimon-ai/doompi-config/harnessStore';
import type { PackageAttribution } from '@agimon-ai/doompi-config/types';
import { readDoomMcpStatus } from '@agimon-ai/doompi-extension-contracts/mcp-status';
import { readDoomSkillSourcesService } from '@agimon-ai/doompi-extension-contracts/skills';
import { buildSkillCatalog, counter, type SkillEntry } from '@agimon-ai/doompi-skill/catalog';
import { extensionName, extensionPackageName, extensionToolSource } from '@agimon-ai/doompi-ui/extensionName';
import { buildToolSources } from '@agimon-ai/doompi-ui/toolInventory';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ContextItemDetail } from '../types/contextApi.ts';
import { buildContextDetail } from './contextDetail.ts';
import { DOOM_CONTEXT_ENTRY_TYPE, projectContext } from './contextProjection.ts';

/**
 * Publishes what the session is composed of, and what it costs.
 *
 * Read at publish time rather than accumulated, because the answer changes for
 * reasons this module does not see: a reconnected MCP server, a domain switch,
 * a plan-mode tool swap. Reading the live inventory is cheap next to being
 * wrong about it.
 */
export interface ContextPublisher {
  /** Never rejects: callers fire this and forget it. */
  publish: () => Promise<void>;
  dispose: () => void;
}

/** The active minor modes at publish time, read rather than remembered. */
export type ReadMinorModes = () => readonly { readonly id: string; readonly label: string }[];

export interface ContextPublisherOptions {
  readMinorModes?: ReadMinorModes;
  /**
   * The session the detail file is keyed by, read at publish time.
   *
   * Undefined until a session is bound, and undefined in a host that has no
   * session at all; the projection is still journaled either way, and only the
   * click-through detail goes unwritten.
   */
  readSessionId?: () => string | undefined;
  /**
   * Where the click-through detail is left for the session API to find.
   *
   * Injected because writing it is filesystem work and this is not the layer
   * that does filesystem work. A host that supplies neither still gets the
   * projection; only the detail behind a row goes unpublished.
   */
  writeDetail?: (sessionId: string, revision: number, items: readonly ContextItemDetail[]) => void;
  removeDetail?: (sessionId: string) => void;
}

/** Skills sit under owners, which is one level deeper than a flat list. */
function flattenSkills(groups: Awaited<ReturnType<typeof buildSkillCatalog>>['groups']): SkillEntry[] {
  return groups.flatMap((group) => group.owners.flatMap((owner) => owner.skills));
}

/**
 * Package and plugin names to the mode that admitted them.
 *
 * Two halves meet here. Layer packages come from the harness, recorded when the
 * composition resolved. Domain plugins are re-resolved, because only the plugin
 * entry knows the domain that carried it.
 */
function attributionFor(repoRoot: string, domains: readonly string[], pluginDirectories: readonly string[]) {
  const harness = getHarnessState();
  const attribution: Record<string, PackageAttribution> = { ...harness.packageAttribution };
  try {
    for (const entry of resolvePluginEntries(repoRoot, [...domains], [...pluginDirectories])) {
      if (entry.name && entry.domain) attribution[entry.name] = { kind: 'domain', mode: entry.domain };
    }
  } catch {
    // A domain that no longer resolves must not cost the reader the tool list.
    // Anything unmatched simply lands under core.
  }
  return attribution;
}

export function createContextPublisher(
  pi: ExtensionAPI,
  cordis: Context,
  options: ContextPublisherOptions = {},
): ContextPublisher {
  let published: string | undefined;
  let revision = 0;
  let disposed = false;
  /** Removed on disposal, so a session leaves nothing behind in the store. */
  let detailSessionId: string | undefined;

  const build = async (): Promise<void> => {
    if (disposed) return;
    const harness = getHarnessState();
    const mcpServers = readDoomMcpStatus(cordis)?.getSnapshot().servers;
    const sources = buildToolSources({
      tools: pi.getAllTools(),
      activeTools: pi.getActiveTools(),
      ...(mcpServers ? { mcpServers } : {}),
      resolveExtensionName: extensionName,
      resolveExtensionPackageName: extensionPackageName,
      resolveExtensionToolSource: (toolName) => extensionToolSource(pi, toolName),
    });

    const repoRoot = harnessRoot(harness);
    let skills: SkillEntry[] = [];
    try {
      const catalog = await buildSkillCatalog({
        repoRoot,
        activeSkillDirectories: harness.skillDirectories,
        extensionSources: readDoomSkillSourcesService(cordis)?.list() ?? [],
      });
      skills = flattenSkills(catalog.groups);
    } catch {
      // Tools are the larger cost and are already in hand; a skill walk that
      // fails should not take the whole figure down with it.
    }

    const countTokens = await counter();
    const projection = projectContext({
      revision: revision + 1,
      majorMode: harness.majorMode,
      minorModes: options.readMinorModes?.() ?? [],
      domains: harness.domains,
      sources,
      skills,
      attribution: attributionFor(repoRoot, harness.domains, harness.pluginDirectories),
      countTokens,
    });

    // Revision is compared out, so a republish that changed nothing is silent
    // rather than a new journal entry saying the same thing.
    const serialized = JSON.stringify({ ...projection, revision: 0 });
    if (serialized === published || disposed) return;
    published = serialized;
    revision += 1;
    // The detail lands before the entry that invites a reader to ask for it, so
    // a click that follows the panel's update cannot outrun the file behind it.
    const sessionId = options.readSessionId?.();
    if (sessionId !== undefined && sessionId !== '' && options.writeDetail !== undefined) {
      detailSessionId = sessionId;
      options.writeDetail(sessionId, revision, buildContextDetail({ sources, skills, countTokens }));
    }
    pi.appendEntry(DOOM_CONTEXT_ENTRY_TYPE, { ...projection, revision });
  };

  /**
   * Reporting the composition is a convenience, so it fails quietly.
   *
   * Callers publish without awaiting, and an escaping rejection would surface
   * as an unhandled error in a live session. A panel that cannot say what the
   * toolbox costs is a far smaller problem than that.
   */
  const publish = async (): Promise<void> => {
    try {
      await build();
    } catch {
      // Left unreported on purpose: the next composition change tries again.
    }
  };

  return {
    publish,
    dispose: () => {
      disposed = true;
      if (detailSessionId !== undefined) options.removeDetail?.(detailSessionId);
      detailSessionId = undefined;
    },
  };
}
