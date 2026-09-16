import {
  ACTION_FIELDS,
  CLI_FIELDS,
  CLI_FRONTEND_FIELDS,
  MERGED_INTO_TOOL,
  NOT_A_CONTRIBUTION,
  SERVER_FIELDS,
  SETTING_FIELDS,
  WEB_FIELDS,
} from '../../constants/contributions';
import type { ExtensionEntry, ExtensionGraph, ExtensionNotice, ExtensionSide } from '../../types/extensionGraph';
import { toSnake } from '../identity';
import type { BuildTarget, ResolvedContribution, TargetResolution } from './type';

/** Nesting order, so roots compose outermost first. */
const SCOPE_DEPTH: Readonly<Record<string, number>> = { global: 0, workspace: 1, session: 2 };

/**
 * Which sides a host reads, and which of their files.
 *
 * The side axis is logic against presentation, not Node against browser, so
 * the terminal reads both: every backend file, plus the frontend files that
 * name it. A frontend file that does not name the terminal is cockpit code,
 * which a terminal cannot render, so the CLI takes only explicit `.cli` ones.
 * The headless server has no presentation at all.
 */
function drawsFrom(entry: ExtensionEntry, target: BuildTarget): boolean {
  if (target === 'web') return entry.side === 'frontend';
  if (entry.side === 'backend') return true;
  return target === 'cli' && entry.platform === 'cli';
}

const FIELDS_OF: Readonly<Record<BuildTarget, Readonly<Record<ExtensionSide, Readonly<Record<string, string>>>>>> = {
  cli: { backend: CLI_FIELDS, frontend: CLI_FRONTEND_FIELDS },
  server: { backend: SERVER_FIELDS, frontend: {} },
  web: { backend: {}, frontend: WEB_FIELDS },
};

/** Everything but the platform: two files sharing this are the same contribution. */
function logicalKey(entry: ExtensionEntry): string {
  const gates = entry.gates.map((gate) => `${gate.kind}:${gate.id}`).join('/');
  const route = entry.route
    .map((segment) => ('literal' in segment ? segment.literal : `[${segment.param.name}]`))
    .join('/');
  // The side is part of it, because the terminal reads both. Without it a
  // tool's logic and its TUI would look like one contribution overriding the
  // other, and only one of the pair would survive.
  return [entry.side, entry.scope, gates, entry.surface ?? '', route, entry.name, entry.target ?? ''].join('|');
}

/** Resolves the field for a surface whose filename target picks between two shapes. */
function variantField(
  table: Readonly<Record<string, string>>,
  fallback: string,
  entryTarget: string | undefined,
): string {
  if (entryTarget === undefined) return fallback;
  return table[entryTarget] ?? fallback;
}

function fieldFor(entry: ExtensionEntry, target: BuildTarget): string | undefined {
  const surface = entry.surface;
  if (surface === undefined) return undefined;

  const declared = FIELDS_OF[target][entry.side][surface];
  if (declared === undefined || declared === NOT_A_CONTRIBUTION) return undefined;

  if (target === 'web' && surface === 'lifecycle' && entry.name !== 'start') return undefined;
  if (target === 'web' && surface === 'setting') return variantField(SETTING_FIELDS, declared, entry.target);
  if (target === 'web' && surface === 'action') return variantField(ACTION_FIELDS, declared, entry.target);
  return declared;
}

/**
 * Folds terminal tool renderers into the tool declarations they draw.
 *
 * Paired by the snake-cased filename, which is the tool's name on both sides.
 * A renderer naming no tool this package contributes is reported rather than
 * dropped: it is almost always a rename that only half landed, and a silently
 * missing renderer is the kind of thing nobody notices until a demo.
 */
function mergeRenderers(
  contributions: readonly ResolvedContribution[],
  notices: ExtensionNotice[],
): ResolvedContribution[] {
  const renderers = new Map<string, ExtensionEntry>();
  const rest: ResolvedContribution[] = [];
  for (const contribution of contributions) {
    if (contribution.field !== MERGED_INTO_TOOL) rest.push(contribution);
    else renderers.set(toSnake(contribution.entry.name), contribution.entry);
  }
  if (renderers.size === 0) return rest;

  const merged = rest.map((contribution) => {
    if (contribution.field !== 'tools') return contribution;
    const name = toSnake(contribution.entry.name);
    const found = renderers.get(name);
    if (found === undefined) return contribution;
    renderers.delete(name);
    return { ...contribution, renderers: found };
  });

  for (const orphan of renderers.values()) {
    notices.push({ path: orphan.file, message: `renders a tool no backend file contributes; nothing will draw it` });
  }
  return merged;
}

/**
 * Picks the winning file per logical contribution for one host.
 *
 * Metro and Expo semantics: a file naming this platform replaces a sibling
 * that names none, and a file naming none serves every platform on its side
 * that has no more specific sibling. The scan reports the unnamed one, so this
 * is a fallback rather than a supported way to author. Two files naming the
 * same platform for the same contribution is an authoring mistake, so the
 * first wins and the second becomes a notice rather than silently disappearing.
 */
export function resolveTarget(graph: ExtensionGraph, target: BuildTarget): TargetResolution {
  const notices: ExtensionNotice[] = [];
  const escapeHatches: ExtensionEntry[] = [];
  const roots: ExtensionEntry[] = [];
  const winners = new Map<string, ExtensionEntry>();

  for (const entry of graph.entries) {
    if (!drawsFrom(entry, target)) continue;
    if (entry.platform !== undefined && entry.platform !== target) continue;

    if (entry.role === 'escape-hatch') {
      escapeHatches.push(entry);
      continue;
    }

    if (entry.role === 'root') {
      // Backend only. A root is constructed from a mount context, and the
      // cockpit has none: it builds its plugin definition as data and starts
      // it separately, so there is nothing for a frontend root to receive.
      if (entry.side === 'frontend') {
        notices.push({ path: entry.file, message: 'a scope root is a backend file; the cockpit has no mount context' });
        continue;
      }
      roots.push(entry);
      continue;
    }

    const key = logicalKey(entry);
    const held = winners.get(key);
    if (held === undefined) {
      winners.set(key, entry);
      continue;
    }
    if (held.platform === entry.platform) {
      notices.push({ path: entry.file, message: `duplicates ${held.file} for ${target}; the first one wins` });
      continue;
    }
    // A platform file always beats the unsuffixed sibling it overrides.
    if (entry.platform !== undefined) winners.set(key, entry);
  }

  const contributions: ResolvedContribution[] = [];
  for (const entry of winners.values()) {
    const field = fieldFor(entry, target);
    if (field === undefined) continue;
    contributions.push({ entry, field });
  }

  return {
    target,
    contributions: mergeRenderers(contributions, notices),
    escapeHatches,
    roots: roots.sort((left, right) => SCOPE_DEPTH[left.scope] - SCOPE_DEPTH[right.scope]),
    notices,
  };
}
