import type { SlotDeclaration, TransientTab } from '@agimon-ai/doompi-core/web';

import type { StyleSystemCatalogComponent, StyleSystemCatalogView } from '../../../../../types/styleSystemCatalog';

export interface BrowserSelection {
  /** A story directory prefix; '' browses every folder. */
  folder: string;
  tags: string[];
  storyPath: string;
  appPath: string;
  storyExport: string;
}

export interface StoryFolder {
  path: string;
  /** The folder's own segments, compacted with any single-child chain below it. */
  label: string;
  depth: number;
  count: number;
}

const selections = new Map<string, BrowserSelection>();
export const maxFolderDepth = 5;
/** Monorepo group, category and package stay separate rows; deeper single-child chains such as src/extensions/... collapse. */
const uncompactedFolderDepth = 3;
export function initialBrowserSelection(): BrowserSelection {
  return { folder: '', tags: [], storyPath: '', appPath: '', storyExport: '' };
}
export function browserSelection(sessionId: string | null): BrowserSelection {
  return sessionId === null ? initialBrowserSelection() : (selections.get(sessionId) ?? initialBrowserSelection());
}
export function rememberBrowserSelection(sessionId: string | null, selection: BrowserSelection): void {
  if (sessionId !== null) selections.set(sessionId, selection);
}
export function forgetBrowserSelection(sessionId: string): void {
  selections.delete(sessionId);
}
export function matchesQuery(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}
export function componentKeywords(component: StyleSystemCatalogComponent): string {
  return [
    component.title,
    component.storyPath,
    ...component.tags,
    ...component.exports.map((entry) => `${entry.exportName} ${entry.label ?? ''}`),
  ].join(' ');
}
export function filteredComponents(catalog: StyleSystemCatalogView, selection: BrowserSelection) {
  return catalog.components.filter(
    (component) =>
      (selection.folder === '' || component.storyPath.startsWith(`${selection.folder}/`)) &&
      selection.tags.every((tag) => component.tags.includes(tag)),
  );
}

interface FolderNode {
  children: Map<string, FolderNode>;
  own: number;
  count: number;
}
/** Only folders holding stories somewhere below appear, deep single-child chains collapse, and nesting stops at maxFolderDepth. */
export function storyFolders(components: readonly StyleSystemCatalogComponent[]): StoryFolder[] {
  const root: FolderNode = { children: new Map(), own: 0, count: 0 };
  for (const component of components) {
    const end = component.storyPath.lastIndexOf('/');
    if (end <= 0) continue;
    let node = root;
    for (const segment of component.storyPath.slice(0, end).split('/')) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { children: new Map(), own: 0, count: 0 };
        node.children.set(segment, child);
      }
      child.count += 1;
      node = child;
    }
    node.own += 1;
  }
  const folders: StoryFolder[] = [];
  const onlyChild = (node: FolderNode, depth: number) =>
    depth >= uncompactedFolderDepth && node.own === 0 && node.children.size === 1 ? [...node.children][0] : undefined;
  const walk = (node: FolderNode, prefix: string, depth: number): void => {
    for (const [segment, start] of [...node.children].sort(([a], [b]) => a.localeCompare(b))) {
      let child = start;
      let label = segment;
      for (let only = onlyChild(child, depth); only !== undefined; only = onlyChild(child, depth)) {
        label = `${label}/${only[0]}`;
        child = only[1];
      }
      const path = `${prefix}${label}`;
      folders.push({ path, label, depth, count: child.count });
      if (depth + 1 < maxFolderDepth) walk(child, `${path}/`, depth + 1);
    }
  };
  walk(root, '', 0);
  return folders;
}

interface AuthorSourceAction {
  version: 1;
  createTab(input: {
    sessionId: string;
    path: string;
    preview?: { appPath: string; storyExport: string; snapshot?: boolean };
  }): TransientTab;
}
export const authorSourceActionSlot: SlotDeclaration<AuthorSourceAction> = {
  slot: 'author.open-source',
  parse(input) {
    if (typeof input !== 'object' || input === null) return null;
    const action = input as Partial<AuthorSourceAction>;
    return action.version === 1 && typeof action.createTab === 'function' ? (action as AuthorSourceAction) : null;
  },
};
