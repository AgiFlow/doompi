import {
  ACTION_FIELDS,
  ACTIVITY_FILL_TARGET,
  CLI_FIELDS,
  FILL_FIELDS,
  NOT_A_CONTRIBUTION,
  SERVER_FIELDS,
  SETTING_FIELDS,
  WEB_FIELDS,
} from '../../constants/contributions';
import type { ExtensionEntry, ExtensionGraph, ExtensionNotice, ExtensionSide } from '../../types/extensionGraph';
import type { BuildTarget, ResolvedContribution, TargetResolution } from './type';

const SIDE_OF: Readonly<Record<BuildTarget, ExtensionSide>> = {
  cli: 'backend',
  server: 'backend',
  web: 'frontend',
};

const FIELDS_OF: Readonly<Record<BuildTarget, Readonly<Record<string, string>>>> = {
  cli: CLI_FIELDS,
  server: SERVER_FIELDS,
  web: WEB_FIELDS,
};

/** Everything but the platform: two files sharing this are the same contribution. */
function logicalKey(entry: ExtensionEntry): string {
  const gates = entry.gates.map((gate) => `${gate.kind}:${gate.id}`).join('/');
  const route = entry.route
    .map((segment) => ('literal' in segment ? segment.literal : `[${segment.param.name}]`))
    .join('/');
  return [entry.scope, gates, entry.surface ?? '', route, entry.name, entry.target ?? ''].join('|');
}

/** Splits `activity` and `activity.<group>` apart, since only the second resolves late. */
function fillField(target: string | undefined): { field: string; activityGroup: string | undefined } | undefined {
  if (target === undefined) return undefined;
  const direct = FILL_FIELDS[target];
  if (direct !== undefined) return { field: direct, activityGroup: undefined };

  const [head, ...rest] = target.split('.');
  if (head === ACTIVITY_FILL_TARGET && rest.length > 0) {
    return { field: FILL_FIELDS[ACTIVITY_FILL_TARGET] as string, activityGroup: rest.join('.') };
  }
  // Anything else is `<pluginId>.<name>`, another plugin's slot.
  return { field: 'fills', activityGroup: undefined };
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

function fieldFor(
  entry: ExtensionEntry,
  target: BuildTarget,
): { field: string; activityGroup: string | undefined } | undefined {
  const surface = entry.surface;
  if (surface === undefined) return undefined;

  const declared = FIELDS_OF[target][surface];
  if (declared === undefined || declared === NOT_A_CONTRIBUTION) return undefined;

  if (target === 'web' && surface === 'fill') return fillField(entry.target);
  if (target === 'web' && surface === 'setting') {
    return { field: variantField(SETTING_FIELDS, declared, entry.target), activityGroup: undefined };
  }
  if (target === 'web' && surface === 'action') {
    return { field: variantField(ACTION_FIELDS, declared, entry.target), activityGroup: undefined };
  }
  return { field: declared, activityGroup: undefined };
}

/**
 * Picks the winning file per logical contribution for one host.
 *
 * Metro and Expo semantics: a file naming this platform replaces the neutral
 * one, and a neutral file serves every platform on its side that has no more
 * specific sibling. Two files naming the same platform for the same
 * contribution is an authoring mistake, so the first wins and the second
 * becomes a notice rather than silently disappearing.
 */
export function resolveTarget(graph: ExtensionGraph, target: BuildTarget): TargetResolution {
  const side = SIDE_OF[target];
  const notices: ExtensionNotice[] = [];
  const escapeHatches: ExtensionEntry[] = [];
  const winners = new Map<string, ExtensionEntry>();

  for (const entry of graph.entries) {
    if (entry.side !== side) continue;
    if (entry.platform !== undefined && entry.platform !== target) continue;

    if (entry.escapeHatch) {
      escapeHatches.push(entry);
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
    // A platform file always beats the neutral sibling it overrides.
    if (entry.platform !== undefined) winners.set(key, entry);
  }

  const contributions: ResolvedContribution[] = [];
  for (const entry of winners.values()) {
    const resolved = fieldFor(entry, target);
    if (resolved === undefined) continue;
    contributions.push({ entry, field: resolved.field, activityGroup: resolved.activityGroup });
  }

  return { target, contributions, escapeHatches, notices };
}
