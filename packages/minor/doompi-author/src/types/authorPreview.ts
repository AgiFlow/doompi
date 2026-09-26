import type { SlotDeclaration, TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import type { ComponentType } from 'react';

export interface AuthorPreviewActionSource {
  path: string;
  hasUnsavedChanges: boolean;
  kind?: string;
  revision?: number;
  sourceSha256?: string;
}

export interface AuthorPreviewAnnotationLocation {
  mode: 'region' | 'point';
  /** Feedback-only normalized location mark, never an editable source region. */
  stroke?: readonly { x: number; y: number }[];
  point: { x: number; y: number };
  rect?: { x: number; y: number; width: number; height: number };
}

export interface AuthorPreviewDisplayedAnnotation extends AuthorPreviewAnnotationLocation {
  ordinal: number;
}

export interface AuthorPreviewAnnotationCandidate extends AuthorPreviewAnnotationLocation {
  preview: AuthorStoryPreviewIdentity;
  evidence: Blob;
  thumbnailUrl: string;
}

export interface AuthorPreviewPanelProps extends WebPluginSlotProps {
  source: AuthorPreviewActionSource;
  activeTool?: 'select' | 'mark' | 'comment' | 'draw' | 'pan';
  displayedAnnotations?: readonly AuthorPreviewDisplayedAnnotation[];
  pendingCandidate?: boolean;
  onAnnotationCandidate?: (candidate: AuthorPreviewAnnotationCandidate) => void;
}

export interface AuthorPreviewAction {
  version: 1;
  label: string;
  detail?: string;
  createTab(input: { source?: AuthorPreviewActionSource }): TransientTab;
  supportsSource?: (source: AuthorPreviewActionSource) => boolean;
  embeddedPanel?: ComponentType<AuthorPreviewPanelProps>;
}

export function parseAuthorPreviewAction(input: unknown): AuthorPreviewAction | null {
  if (typeof input !== 'object' || input === null) return null;
  const candidate = input as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.label !== 'string' || candidate.label.trim() === '') return null;
  if (candidate.detail !== undefined && typeof candidate.detail !== 'string') return null;
  if (typeof candidate.createTab !== 'function') return null;
  if (candidate.supportsSource !== undefined && typeof candidate.supportsSource !== 'function') return null;
  if (candidate.embeddedPanel !== undefined && typeof candidate.embeddedPanel !== 'function') return null;
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
