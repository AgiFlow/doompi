import type { SlotDeclaration, TransientTab } from '@agimon-ai/doompi-core/web';

export interface AuthorPreviewActionSource {
  path: string;
  hasUnsavedChanges: boolean;
}

export interface AuthorPreviewAction {
  version: 1;
  label: string;
  detail?: string;
  createTab(input: { source?: AuthorPreviewActionSource }): TransientTab;
}

export function parseAuthorPreviewAction(input: unknown): AuthorPreviewAction | null {
  if (typeof input !== 'object' || input === null) return null;
  const candidate = input as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.label !== 'string' || candidate.label.trim() === '') return null;
  if (candidate.detail !== undefined && typeof candidate.detail !== 'string') return null;
  if (typeof candidate.createTab !== 'function') return null;
  return candidate as unknown as AuthorPreviewAction;
}

export const authorPreviewActionSlot: SlotDeclaration<AuthorPreviewAction> = {
  slot: 'author.preview-action',
  parse: parseAuthorPreviewAction,
};

export interface AuthorStoryPreviewSource {
  path: string;
  sha256: string;
}

/** Browser-safe identity retained with an immutable story-preview capture. */
export interface AuthorStoryPreviewIdentity {
  version: 1;
  provider: string;
  projectPath: string;
  storyPath: string;
  storyExport: string;
  buildRevision: string;
  viewport: { width: number; height: number };
  sources: readonly AuthorStoryPreviewSource[];
}
