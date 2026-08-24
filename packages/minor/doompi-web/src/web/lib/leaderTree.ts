import type { LeaderBindingContribution } from '@agimon-ai/doompi-web-contracts';

export interface LeaderOption {
  key: string;
  label: string;
  detail: string;
  /** A group opens the next level; a leaf carries the binding that fires. */
  binding?: LeaderBindingContribution;
  /** The keys one level down, for a group's preview; empty for a leaf. */
  children: LeaderOption[];
}

export interface LeaderGroup {
  /** The label of the segment that opened this level; 'leader' at the root. */
  label: string;
  options: LeaderOption[];
}

interface LeaderNode {
  key: string;
  label: string;
  detail: string;
  binding?: LeaderBindingContribution;
  children: Map<string, LeaderNode>;
}

const ROOT_LABEL = 'leader';

/**
 * Inserts one binding the way the TUI registry does: a group segment keeps
 * the label of whoever registered it first (adopting a detail if it had
 * none), and a leaf that is already bound is taken over by the newcomer,
 * along with any group that stood where the leaf now goes.
 */
function insert(root: LeaderNode, binding: LeaderBindingContribution): void {
  let current = root;
  for (const [index, segment] of binding.path.entries()) {
    const isLeaf = index === binding.path.length - 1;
    let node = current.children.get(segment.key);
    if (!node) {
      node = { key: segment.key, label: segment.label, detail: segment.detail ?? '', children: new Map() };
      current.children.set(segment.key, node);
    } else if (!node.detail && segment.detail) {
      node.detail = segment.detail;
    }
    if (isLeaf) {
      node.children.clear();
      node.binding = binding;
      node.label = segment.label;
      node.detail = segment.detail ?? '';
    } else if (node.binding) {
      delete node.binding;
    }
    current = node;
  }
}

export interface LeaderConflict {
  /** A later binding took a bound leaf (or a whole group) over, or a group segment was worded differently. */
  kind: 'leaf-override' | 'group-label';
  /** The keys of the contested segment, space separated. */
  path: string;
  /** The binding the tree keeps: the later one for a leaf, the first namer for a group label. */
  winner: LeaderBindingContribution;
  loser: LeaderBindingContribution;
}

function leavesUnder(node: LeaderNode): LeaderBindingContribution[] {
  const leaves: LeaderBindingContribution[] = [];
  if (node.binding) leaves.push(node.binding);
  for (const child of node.children.values()) leaves.push(...leavesUnder(child));
  return leaves;
}

/**
 * Every place `insert` would silently prefer one binding over another, in
 * the same order insert walks them: a leaf landing on a bound leaf or over a
 * group displaces those bindings, a group segment crossing a bound leaf
 * displaces it, and a group segment worded differently from the first namer
 * keeps the first wording.
 */
export function leaderConflicts(bindings: readonly LeaderBindingContribution[]): LeaderConflict[] {
  const conflicts: LeaderConflict[] = [];
  const root: LeaderNode = { key: '', label: ROOT_LABEL, detail: '', children: new Map() };
  const namers = new Map<LeaderNode, LeaderBindingContribution>();
  for (const binding of bindings) {
    let current = root;
    const keys: string[] = [];
    for (const [index, segment] of binding.path.entries()) {
      keys.push(segment.key);
      const path = keys.join(' ');
      const isLeaf = index === binding.path.length - 1;
      let node = current.children.get(segment.key);
      if (node) {
        if (isLeaf) {
          for (const loser of leavesUnder(node)) {
            if (loser !== binding) conflicts.push({ kind: 'leaf-override', path, winner: binding, loser });
          }
        } else {
          if (node.binding && node.binding !== binding) {
            conflicts.push({ kind: 'leaf-override', path, winner: binding, loser: node.binding });
          }
          const namer = namers.get(node);
          if (namer !== undefined && namer !== binding && node.label !== segment.label) {
            conflicts.push({ kind: 'group-label', path, winner: namer, loser: binding });
          }
        }
      } else {
        node = { key: segment.key, label: segment.label, detail: '', children: new Map() };
        current.children.set(segment.key, node);
        namers.set(node, binding);
      }
      if (isLeaf) {
        node.children.clear();
        node.binding = binding;
        node.label = segment.label;
        namers.set(node, binding);
      } else if (node.binding) {
        delete node.binding;
      }
      current = node;
    }
  }
  return conflicts;
}

function toOption(node: LeaderNode): LeaderOption {
  const children = [...node.children.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((child) => ({ key: child.key, label: child.label, detail: child.detail, children: [] }));
  return {
    key: node.key,
    label: node.label,
    detail: node.detail,
    ...(node.binding ? { binding: node.binding } : {}),
    children,
  };
}

/**
 * The options one level of Leader Space offers, keyed by what the reader
 * would press, sorted by key. Undefined when the path runs off the tree or
 * lands on a leaf, which is how the palette knows a path is no longer a group.
 */
export function leaderGroup(
  bindings: readonly LeaderBindingContribution[],
  path: readonly string[],
): LeaderGroup | undefined {
  const root: LeaderNode = { key: '', label: ROOT_LABEL, detail: '', children: new Map() };
  for (const binding of bindings) insert(root, binding);
  let current = root;
  for (const key of path) {
    const next = current.children.get(key);
    if (!next || next.binding) return undefined;
    current = next;
  }
  const options = [...current.children.values()].sort((left, right) => left.key.localeCompare(right.key)).map(toOption);
  return { label: current.label, options };
}
