import type { SlotDeclaration, TransientTab } from '@agimon-ai/doompi-core/web';

import type { StyleSystemCatalogView } from '../../../../../types/styleSystemCatalog';

export interface BrowserSelection {
  scope: string;
  search: string;
  preset: string;
  bundler: string;
  tag: string;
  page: number;
  storyPath: string;
  appPath: string;
  storyExport: string;
}

const selections = new Map<string, BrowserSelection>();
export const browserPageSize = 40;
export function initialBrowserSelection(): BrowserSelection {
  return {
    scope: 'all',
    search: '',
    preset: '',
    bundler: '',
    tag: '',
    page: 0,
    storyPath: '',
    appPath: '',
    storyExport: '',
  };
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
export function filteredComponents(catalog: StyleSystemCatalogView, selection: BrowserSelection) {
  const terms = selection.search.toLowerCase().trim().split(/\s+/u).filter(Boolean);
  const projects = new Map(catalog.projects.map((project) => [project.appPath, project]));
  return catalog.components.filter((component) => {
    if (selection.scope === 'shared' && !component.shared) return false;
    if (selection.scope === 'unassigned' && component.projectPath !== undefined) return false;
    if (selection.scope.startsWith('project:') && component.projectPath !== selection.scope.slice(8)) return false;
    const project = component.projectPath === undefined ? undefined : projects.get(component.projectPath);
    if (selection.preset !== '' && project?.preset !== selection.preset) return false;
    if (selection.bundler !== '' && (project?.bundler ?? 'vite-react') !== selection.bundler) return false;
    if (selection.tag !== '' && !component.tags.includes(selection.tag)) return false;
    const haystack = [
      component.title,
      component.storyPath,
      ...component.tags,
      ...component.exports.map((entry) => `${entry.exportName} ${entry.label ?? ''}`),
    ]
      .join(' ')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
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
