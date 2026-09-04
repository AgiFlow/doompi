import type { AuthorJsonSchema } from '../types/author.ts';
import type { CsvDialect, DocumentFragment, StructuredDocumentFormat } from '../types/structuredDocuments.ts';

export type AuthorDocumentKind =
  | 'text'
  | 'markdown'
  | 'slides'
  | 'csv'
  | 'pptx'
  | 'xlsx'
  | 'image'
  | 'video'
  | 'pdf'
  | 'opaque';

export interface AuthorDocumentInput {
  path: string;
  kind: AuthorDocumentKind;
  content?: string;
  mediaUrl?: string;
  title?: string;
  sourceSha256?: string;
  structuredFormat?: StructuredDocumentFormat;
  csvDialect?: CsvDialect;
  fragments?: readonly DocumentFragment[];
  originalFragments?: readonly DocumentFragment[];
}

export interface AuthorAnnotation {
  id: string;
  kind: 'comment' | 'highlight';
  body: string;
  quote?: string;
  startLine?: number;
  endLine?: number;
}

export interface AuthorDraftRevision {
  revision: number;
  content: string;
}

/** A rectangle expressed relative to its source, not its current CSS size. */
export interface AuthorNormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Legacy image crop shape. Coordinates are source-normalized for new records. */
export type AuthorCrop = AuthorNormalizedRect;

export interface AuthorTextRangeAnchor {
  kind: 'text-range';
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

export interface AuthorCellAnchor {
  kind: 'cell';
  fragmentId: string;
  location: string;
  row?: number;
  column?: number;
  sheet?: string;
}

export interface AuthorSlideElementAnchor {
  kind: 'slide-element';
  fragmentId: string;
  slide: number;
  elementId?: string;
  location: string;
}

export interface AuthorImageRectAnchor {
  kind: 'image-rect';
  rect: AuthorNormalizedRect;
  naturalWidth: number;
  naturalHeight: number;
}

export interface AuthorPdfPageRectAnchor {
  kind: 'pdf-page-rect';
  page: number;
  rect: AuthorNormalizedRect;
}

export interface AuthorVideoTimeRectAnchor {
  kind: 'video-time-rect';
  timeSeconds: number;
  rect: AuthorNormalizedRect;
  frame?: number;
  intrinsicWidth?: number;
  intrinsicHeight?: number;
}

export type AuthorNativeAnchor =
  | AuthorTextRangeAnchor
  | AuthorCellAnchor
  | AuthorSlideElementAnchor
  | AuthorImageRectAnchor
  | AuthorPdfPageRectAnchor
  | AuthorVideoTimeRectAnchor;

/** View state retained as capture evidence, never as mutation authority. */
export interface AuthorViewportSnapshot {
  width: number;
  height: number;
  scrollX?: number;
  scrollY?: number;
  zoom?: number;
  page?: number;
  slide?: number;
  timeSeconds?: number;
}

export interface AuthorVoiceGridEvidence {
  cell: string;
  geometryToken: string;
  snapshotId: string;
}

export type AuthorToolMode = 'select' | 'mark' | 'crop';

export interface AuthorRegionCandidate {
  documentPath: string;
  revision: number;
  sourceSha256?: string;
  quote?: string;
  anchor: AuthorNativeAnchor;
  viewport: AuthorViewportSnapshot;
  voiceGrid?: AuthorVoiceGridEvidence;
  thumbnailUrl?: string;
  createdAt: number;
}

export interface AuthorRegionDraft {
  id: string;
  documentPath: string;
  revision: number;
  sourceSha256?: string;
  comment: string;
  quote?: string;
  anchor: AuthorNativeAnchor;
  viewport: AuthorViewportSnapshot;
  voiceGrid?: AuthorVoiceGridEvidence;
  thumbnailUrl?: string;
  createdAt: number;
}

export type AuthorRequestStatus = 'REQUESTED' | 'CHANGING' | 'CHANGED' | 'COMPLETE' | 'FAILED' | 'CANCELLED';

export interface AuthorRequestRecord {
  id: string;
  captureId?: string;
  documentPath: string;
  requestText: string;
  regions: readonly AuthorRegionDraft[];
  status: AuthorRequestStatus;
  currentOperation?: string;
  before?: string;
  after?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  sourceSha256?: string;
}

export interface AuthorFocusedDocument {
  path: string;
  generation: number;
  revision: number;
  sourceSha256?: string;
  focusedAt: number;
}

export interface AuthorTrustedTool {
  name: string;
  label?: string;
  description: string;
  inputSchema: AuthorJsonSchema;
  execute(input: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface AuthorTrustedProfile {
  id: string;
  tools: readonly AuthorTrustedTool[];
}
