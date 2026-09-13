/** What admitted a package into the composition. */
export interface PackageAttribution {
  /** `major` for a layer package, `domain` for a plugin a domain carries. */
  kind: 'major' | 'domain';
  /** The major mode name, or the domain name. */
  mode: string;
  /** The layer the package was listed under; absent for a domain plugin. */
  layer?: string;
}

import { type CountTokens, type ToolEntry, type ToolSource, tokensForTool } from '../toolInventory';

/**
 * What the session is carrying, and what carrying it costs.
 *
 * Grouped by the mode that admitted each package rather than by where the tool
 * came from, because a mode is the thing a reader can switch off. The mechanism
 * (extension, MCP server, plugin) orders rows inside a group instead, so the
 * expensive thing is still easy to find.
 *
 * Schemas never travel. Only names, kinds, owners and integer counts do, which
 * keeps the payload small enough to republish whenever the composition changes.
 */
export const CONTEXT_PROJECTION_VERSION = 1;

/** Journal entry the cockpit reads; mirrored by CONTEXT_ENTRY_TYPE in doompi-web. */
export const DOOM_CONTEXT_ENTRY_TYPE = 'doom-context';

/** The tokenizer these counts came from, so a reader can judge them. */
export const CONTEXT_PROJECTION_ESTIMATOR = 'gpt-tokenizer';

export type ContextGroupKind = 'major' | 'minor' | 'domain' | 'core';
export type ContextItemSource = 'extension' | 'mcp' | 'plugin' | 'core';

/** Everything the runtime could not attribute lands here rather than vanishing. */
const CORE_GROUP = 'core';
/** Pi's own tools have no package; the runtime itself is the owner. */
const CORE_OWNER = 'pi';
const MCP_KEY_PREFIX = 'mcp:';

const KIND_ORDER: Record<ContextGroupKind, number> = { major: 0, minor: 1, domain: 2, core: 3 };
const SOURCE_ORDER: Record<ContextItemSource, number> = { extension: 0, mcp: 1, plugin: 2, core: 3 };

export interface ContextItemProjection {
  readonly name: string;
  readonly itemKind: 'tool' | 'skill';
  readonly source: ContextItemSource;
  /** The package, server, or plugin that registered it. */
  readonly owner: string;
  readonly tokens: number;
  readonly active: boolean;
}

export interface ContextGroupProjection {
  readonly id: string;
  readonly label: string;
  readonly kind: ContextGroupKind;
  readonly items: readonly ContextItemProjection[];
  /** What the group costs now: active items only. */
  readonly tokens: number;
  /** What its gated items would add if switched on. */
  readonly inactiveTokens: number;
}

export interface ContextProjection {
  readonly version: typeof CONTEXT_PROJECTION_VERSION;
  readonly revision: number;
  /** Selection snapshot used to build this projection, replayable after reconnect. */
  readonly selection: {
    readonly majorMode: string;
    readonly domains: readonly string[];
    readonly profile?: string;
  };
  readonly groups: readonly ContextGroupProjection[];
  readonly totalTokens: number;
  readonly inactiveTokens: number;
  readonly estimator: typeof CONTEXT_PROJECTION_ESTIMATOR;
}

export interface ContextConditionalAttribution {
  readonly kind: 'minor' | 'domain';
  readonly mode: string;
  readonly label?: string;
}

export interface ContextToolInventory extends ToolEntry {
  /** A contribution-level gate is more specific than its package's major-mode owner. */
  readonly contextAttribution?: ContextConditionalAttribution;
}

export interface ContextToolSource extends Omit<ToolSource, 'tools'> {
  readonly tools: readonly ContextToolInventory[];
}

/** Skill fields needed to project cost and serve detail. Virtual resources may not have a filesystem path. */
export interface ContextSkillInventory {
  readonly name: string;
  readonly description: string;
  readonly group: 'extensions' | 'help' | 'plugins' | 'default';
  readonly owner: string;
  readonly modelInvocable: boolean;
  readonly promptTokens?: number;
  readonly filePath?: string;
  readonly contextAttribution?: ContextConditionalAttribution;
}

export interface ContextProjectionInput {
  readonly revision: number;
  readonly majorMode: string;
  readonly profile?: string;
  /** Additional groups supplied by the composition owner, in display order. */
  readonly groups: readonly { readonly id: string; readonly label: string; readonly kind: ContextGroupKind }[];
  /** Domains the composition resolved under, whether or not they carried a plugin. */
  readonly domains: readonly string[];
  readonly sources: readonly ContextToolSource[];
  readonly skills: readonly ContextSkillInventory[];
  /**
   * Owner identifier to the mode that admitted it.
   *
   * Keys are package names for extensions and layer packages, and plugin or
   * server names for anything a domain carries. The caller owns this join
   * because only it knows how a given deployment resolved its plugins.
   */
  readonly attribution: Readonly<Record<string, PackageAttribution>>;
  readonly countTokens: CountTokens;
}

interface Bucket {
  kind: ContextGroupKind;
  label: string;
  items: ContextItemProjection[];
}

function skillSource(group: ContextSkillInventory['group']): ContextItemSource {
  if (group === 'plugins') return 'plugin';
  if (group === 'extensions') return 'extension';
  return 'core';
}

function byRow(left: ContextItemProjection, right: ContextItemProjection): number {
  return SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source] || left.name.localeCompare(right.name);
}

export function projectContext(input: ContextProjectionInput): ContextProjection {
  const buckets = new Map<string, Bucket>();

  // Declared before anything is placed, so a mode with nothing attributed to it
  // still appears. An empty group is a fact worth showing: it says the mode is
  // on and cheap, not that the runtime forgot about it.
  const declare = (id: string, label: string, kind: ContextGroupKind): void => {
    if (!buckets.has(id)) buckets.set(id, { kind, label, items: [] });
  };
  if (input.majorMode) declare(input.majorMode, input.majorMode, 'major');
  for (const group of input.groups) declare(group.id, group.label, group.kind);
  // A domain that contributed no plugin is still part of what the session is
  // running under, and a reader comparing the panel against the footer would
  // otherwise read its absence as the panel being out of date.
  for (const domain of input.domains) declare(domain, domain, 'domain');

  const place = (owner: string, item: ContextItemProjection, conditional?: ContextConditionalAttribution): void => {
    const attributed = conditional ?? input.attribution[owner];
    const id = attributed?.mode ?? CORE_GROUP;
    const kind = attributed?.kind ?? 'core';
    declare(id, attributed && 'label' in attributed ? (attributed.label ?? id) : id, kind);
    buckets.get(id)?.items.push(item);
  };

  for (const source of input.sources) {
    // An extension is owned by its package, an MCP tool by the server that
    // advertised it. `label` is display text like `scaffold · mcp`, so the
    // identifier comes from the key instead: an owner is joined on, not read.
    const owner =
      source.kind === 'extension'
        ? (source.packageName ?? source.key)
        : source.kind === 'mcp'
          ? source.key.slice(MCP_KEY_PREFIX.length)
          : CORE_OWNER;
    for (const tool of source.tools) {
      const cost = tokensForTool(tool, input.countTokens);
      const item: ContextItemProjection = {
        name: tool.name,
        itemKind: 'tool',
        source: source.kind === 'core' ? 'core' : source.kind,
        owner,
        tokens: cost.totalTokens,
        active: tool.active,
      };
      if (source.kind === 'core') {
        declare(CORE_GROUP, CORE_GROUP, 'core');
        buckets.get(CORE_GROUP)?.items.push(item);
      } else {
        place(owner, item, tool.contextAttribution);
      }
    }
  }

  for (const skill of input.skills) {
    place(
      skill.owner,
      {
        name: skill.name,
        itemKind: 'skill',
        source: skillSource(skill.group),
        owner: skill.owner,
        tokens: skill.promptTokens ?? 0,
        // A skill is always offered to the model; there is no inactive state for
        // it the way there is for a tool Pi has filtered out.
        active: true,
      },
      skill.contextAttribution,
    );
  }

  const groups: ContextGroupProjection[] = [...buckets.entries()]
    .map(([id, bucket]) => {
      const items = [...bucket.items].sort(byRow);
      // Only what is actually sent counts. Pi builds the prompt from its
      // active tools, so a gated one costs nothing until it is switched on,
      // and folding it into the total would overstate the bill by a third.
      return {
        id,
        label: bucket.label,
        kind: bucket.kind,
        items,
        tokens: items.reduce((total, item) => total + (item.active ? item.tokens : 0), 0),
        inactiveTokens: items.reduce((total, item) => total + (item.active ? 0 : item.tokens), 0),
      };
    })
    .sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind] || left.label.localeCompare(right.label));

  return {
    version: CONTEXT_PROJECTION_VERSION,
    revision: input.revision,
    selection: {
      majorMode: input.majorMode,
      domains: [...input.domains],
      ...(input.profile === undefined ? {} : { profile: input.profile }),
    },
    groups,
    totalTokens: groups.reduce((total, group) => total + group.tokens, 0),
    inactiveTokens: groups.reduce((total, group) => total + group.inactiveTokens, 0),
    estimator: CONTEXT_PROJECTION_ESTIMATOR,
  };
}
