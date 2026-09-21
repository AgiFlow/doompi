import fs from 'node:fs';
import path from 'node:path';

import {
  BACKEND_GROUP,
  BACKEND_PLATFORMS,
  BACKEND_SURFACES,
  DEFAULT_ROUTING_ROOT,
  FRONTEND_GROUP,
  FRONTEND_PLATFORMS,
  FRONTEND_SURFACES,
  GATE_SEGMENTS,
  GENERATED_ENTRY_NAMES,
  ROOT_FILE_NAME,
  ROUTE_FILE_NAME,
  ROUTED_SURFACES,
  ROUTING_ROOT_ALIAS,
  SESSION_SEGMENT,
  WORKSPACE_SEGMENT,
} from '../../constants/layout';
import type {
  ExtensionEntry,
  ExtensionGate,
  ExtensionGraph,
  ExtensionNotice,
  ExtensionScope,
  ExtensionSide,
  RouteSegment,
} from '../../types/extensionGraph';
import { type ParsedFilename, parseFilename } from '../filename';
import { classifySegment } from '../segments';
import type { ScanOptions } from './type';

interface WalkState {
  readonly scope: ExtensionScope;
  readonly side: ExtensionSide | undefined;
  readonly gates: readonly ExtensionGate[];
  readonly surface: string | undefined;
  readonly route: readonly RouteSegment[];
  /** A gate folder has been entered and the next plain segment names its id. */
  readonly pendingGate: string | undefined;
}

const INITIAL: WalkState = {
  scope: 'global',
  side: undefined,
  gates: [],
  surface: undefined,
  route: [],
  pendingGate: undefined,
};

function surfacesFor(side: ExtensionSide): readonly string[] {
  return side === 'backend' ? BACKEND_SURFACES : FRONTEND_SURFACES;
}

function platformsFor(side: ExtensionSide, options: ScanOptions): readonly string[] {
  const configured = side === 'backend' ? options.platforms?.backend : options.platforms?.frontend;
  return configured ?? (side === 'backend' ? BACKEND_PLATFORMS : FRONTEND_PLATFORMS);
}

/** The nearest surface a misspelled folder probably meant, or undefined. */
function nearestSurface(name: string, side: ExtensionSide): string | undefined {
  const surfaces = surfacesFor(side);
  if (surfaces.includes(name)) return undefined;
  const singular = name.endsWith('s') ? name.slice(0, -1) : `${name}s`;
  return surfaces.includes(singular) ? singular : undefined;
}

/** Reads cardinality only from the routed helper's options argument. */
function routedCardinality(source: string): ExtensionEntry['cardinality'] | undefined {
  const declaration =
    /export\s+default\s+defineRoutedContribution\s*\([\s\S]*,\s*\{\s*cardinality\s*:\s*['"](optional|many|collection)['"]/u.exec(
      source,
    );
  return declaration?.[1] as ExtensionEntry['cardinality'] | undefined;
}

/** Resolves the routing root, accepting the singular alias when only it exists. */
export function resolveRoutingRoot(packageDir: string, root: string | undefined): string | undefined {
  const candidates = root !== undefined ? [root] : [DEFAULT_ROUTING_ROOT, ROUTING_ROOT_ALIAS];
  return candidates.find((candidate) => fs.existsSync(path.join(packageDir, candidate)));
}

/**
 * Reads one package's routing root into a description of what it declares.
 *
 * Filesystem in, data out. No globbing, which is what keeps parenthesised
 * group folders safe: tsdown's globber would read a bare `(name)` as an
 * extglob group, and a directory walk never sees a pattern at all.
 *
 * Nothing here throws. A folder the convention does not recognise becomes a
 * notice and its subtree is skipped, so one bad directory never costs a
 * package its other contributions.
 */
export function scanExtensions(options: ScanOptions): ExtensionGraph {
  const root = resolveRoutingRoot(options.packageDir, options.root);
  if (root === undefined) return { root: options.root ?? DEFAULT_ROUTING_ROOT, entries: [], notices: [] };

  const backendGroup = options.sides?.backend ?? BACKEND_GROUP;
  const frontendGroup = options.sides?.frontend ?? FRONTEND_GROUP;
  const generated = options.generatedEntries ?? GENERATED_ENTRY_NAMES;

  const entries: ExtensionEntry[] = [];
  const notices: ExtensionNotice[] = [];
  const note = (relativePath: string, message: string): void => void notices.push({ path: relativePath, message });

  /**
   * Every public routed file names its platform, so a host is never inferred.
   *
   * Checked at each push rather than once at the top of readFile, because a
   * file sitting somewhere the convention does not define has a position
   * problem, and reporting the missing suffix instead would hide it.
   */
  const notePlatform = (relative: string, parsed: ParsedFilename, side: ExtensionSide): void => {
    if (parsed.platform !== undefined) return;
    note(
      relative,
      `names no platform; add one of ${platformsFor(side, options).join(', ')} before .${parsed.extension} (without one the host is inferred from the side rather than declared)`,
    );
  };

  const walk = (relativeDir: string, state: WalkState): void => {
    const absolute = path.join(options.packageDir, relativeDir);
    const listing = fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

    for (const item of listing) {
      const relative = `${relativeDir}/${item.name}`;
      if (item.isDirectory()) walkDirectory(relative, item.name, state);
      else if (item.isFile()) readFile(relative, item.name, state);
    }
  };

  const walkDirectory = (relative: string, name: string, state: WalkState): void => {
    const segment = classifySegment(name);

    if (segment.kind === 'private') return;

    if (segment.kind === 'group') {
      if (state.side === undefined && segment.name === backendGroup)
        return walk(relative, { ...state, side: 'backend' });
      if (state.side === undefined && segment.name === frontendGroup)
        return walk(relative, { ...state, side: 'frontend' });
      return walk(relative, state);
    }

    if (segment.kind === 'dynamic') {
      if (state.surface !== undefined && ROUTED_SURFACES.includes(state.surface)) {
        return walk(relative, { ...state, route: [...state.route, { param: segment.param }] });
      }
      return note(relative, 'a dynamic segment is only meaningful inside a routed surface such as api/');
    }

    if (state.pendingGate !== undefined) {
      const gate: ExtensionGate = { kind: state.pendingGate, id: segment.name };
      return walk(relative, { ...state, gates: [...state.gates, gate], pendingGate: undefined });
    }

    if (state.surface !== undefined) {
      if (ROUTED_SURFACES.includes(state.surface)) {
        return walk(relative, { ...state, route: [...state.route, { literal: segment.name }] });
      }
      return note(relative, `${state.surface}/ takes files directly; put helpers in a _private folder`);
    }

    if (state.side === undefined) {
      if (segment.name === WORKSPACE_SEGMENT && state.scope === 'global') {
        return walk(relative, { ...state, scope: 'workspace' });
      }
      if (segment.name === SESSION_SEGMENT && state.scope === 'workspace') {
        return walk(relative, { ...state, scope: 'session' });
      }
      return note(relative, `expected a scope segment or a side group, such as (${backendGroup})`);
    }

    if (GATE_SEGMENTS.includes(segment.name)) return walk(relative, { ...state, pendingGate: segment.name });

    if (surfacesFor(state.side).includes(segment.name)) return walk(relative, { ...state, surface: segment.name });

    const nearest = nearestSurface(segment.name, state.side);
    return note(
      relative,
      nearest === undefined
        ? `'${segment.name}' is not a ${state.side} surface`
        : `'${segment.name}' is not a surface, did you mean '${nearest}'`,
    );
  };

  const readFile = (relative: string, fileName: string, state: WalkState): void => {
    if (state.side === undefined) {
      const base = fileName.slice(0, fileName.lastIndexOf('.'));
      if (state.scope === 'global' && generated.includes(base)) return;
      // A direct child of the routing root is a host entry, not a
      // contribution: either one this build generates, or one the package
      // hand-writes and names itself. doompi-profile ships a second Pi entry
      // the composition resolver activates by name, and a package that has
      // not adopted the layout has all of its entries here. A contribution
      // always sits at least one directory deep, inside a side group.
      if (state.scope === 'global') return;
      if (parseFilename(fileName, []) === undefined) return;
      return note(relative, 'a contribution needs a side group and a surface folder');
    }

    const platforms = platformsFor(state.side, options);
    const parsed = parseFilename(fileName, [...platforms, 'mcp']);
    if (parsed === undefined) return;
    if (
      parsed.platform === 'mcp' &&
      (state.side !== 'backend' ||
        state.scope !== 'session' ||
        (state.surface !== 'tool' && state.surface !== 'skill' && state.surface !== 'resource'))
    ) {
      return note(relative, 'MCP declarations belong in a session backend tool/, skill/, or resource/ surface');
    }
    const source = fs.readFileSync(path.join(options.packageDir, relative), 'utf8');
    const cardinality = routedCardinality(source);

    if (state.surface === undefined) {
      // Inside `mode/plan/`, a file called `mode.*` declares the gate itself
      // rather than a contribution gated by it, and the gate's id names it.
      const gate = state.gates[state.gates.length - 1];
      if (gate !== undefined && parsed.name === gate.kind) {
        notePlatform(relative, parsed, state.side);
        entries.push({
          file: relative,
          scope: state.scope,
          side: state.side,
          gates: state.gates.slice(0, -1),
          surface: gate.kind,
          route: [],
          name: gate.id,
          target: parsed.target,
          platform: parsed.platform,
          ...(cardinality ? { cardinality } : {}),
          role: 'contribution',
        });
        return;
      }

      // The scope's constructor. Not gated: it owns the whole subtree's
      // lifetime, and a gate that could switch it off would leave everything
      // below it holding a context nothing built.
      if (parsed.name === ROOT_FILE_NAME && gate === undefined) {
        notePlatform(relative, parsed, state.side);
        entries.push({
          file: relative,
          scope: state.scope,
          side: state.side,
          gates: [],
          surface: undefined,
          route: [],
          name: parsed.name,
          target: parsed.target,
          platform: parsed.platform,
          role: 'root',
        });
        return;
      }

      return note(
        relative,
        gate === undefined
          ? `only ${ROOT_FILE_NAME}.* is read at a side root; move each contribution into its named surface folder`
          : `inside ${gate.kind}/${gate.id}/ a contribution needs a surface folder, or name the file ${gate.kind}.* to declare the gate`,
      );
    }

    // Inside a routed surface only the leaf file is a route. Anything beside
    // it is colocation, which is the whole reason Next.js reserves the name.
    if (ROUTED_SURFACES.includes(state.surface) && parsed.name !== ROUTE_FILE_NAME) return;

    notePlatform(relative, parsed, state.side);
    entries.push({
      file: relative,
      scope: state.scope,
      side: state.side,
      gates: state.gates,
      surface: state.surface,
      route: state.route,
      name: parsed.name,
      target: parsed.target,
      platform: parsed.platform,
      ...(cardinality ? { cardinality } : {}),
      role: 'contribution',
    });
  };

  walk(root, INITIAL);
  return { root, entries, notices };
}
