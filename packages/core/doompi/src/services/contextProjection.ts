import type { PackageAttribution } from '@agimon-ai/doompi-config/types';
import type { SkillEntry } from '@agimon-ai/doompi-skill/catalog';
import { type CountTokens, type ToolSource, tokensForTool } from '@agimon-ai/doompi-ui/toolInventory';

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
  readonly groups: readonly ContextGroupProjection[];
  readonly totalTokens: number;
  readonly inactiveTokens: number;
  readonly estimator: typeof CONTEXT_PROJECTION_ESTIMATOR;
}

export interface ContextProjectionInput {
  readonly revision: number;
  readonly majorMode: string;
  /** Active minor modes, in the order the catalog reports them. */
  readonly minorModes: readonly { readonly id: string; readonly label: string }[];
  readonly sources: readonly ToolSource[];
  readonly skills: readonly SkillEntry[];
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

function skillSource(group: SkillEntry['group']): ContextItemSource {
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
  for (const mode of input.minorModes) declare(mode.id, mode.label, 'minor');

  const place = (owner: string, item: ContextItemProjection): void => {
    const attributed = input.attribution[owner];
    const id = attributed?.mode ?? CORE_GROUP;
    declare(id, id, attributed ? (attributed.kind === 'domain' ? 'domain' : 'major') : 'core');
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
        place(owner, item);
      }
    }
  }

  for (const skill of input.skills) {
    place(skill.owner, {
      name: skill.name,
      itemKind: 'skill',
      source: skillSource(skill.group),
      owner: skill.owner,
      tokens: skill.promptTokens ?? 0,
      // A skill is always offered to the model; there is no inactive state for
      // it the way there is for a tool Pi has filtered out.
      active: true,
    });
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
    groups,
    totalTokens: groups.reduce((total, group) => total + group.tokens, 0),
    inactiveTokens: groups.reduce((total, group) => total + group.inactiveTokens, 0),
    estimator: CONTEXT_PROJECTION_ESTIMATOR,
  };
}
