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
