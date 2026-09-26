import type { AuthorJsonSchema } from '../../../../../types/author';
import type { AuthorStoryPreviewIdentity } from '../../../../../types/authorPreview';
import type { CsvDialect, DocumentFragment, StructuredDocumentFormat } from '../../../../../types/structuredDocuments';

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
  | 'story-preview'
  | 'opaque';

export interface AuthorDocumentInput {
  path: string;
  kind: AuthorDocumentKind;
  content?: string;
  mediaUrl?: string;
  crop?: AuthorCrop;
  title?: string;
  sourceSha256?: string;
  structuredFormat?: StructuredDocumentFormat;
  csvDialect?: CsvDialect;
  fragments?: readonly DocumentFragment[];
  originalFragments?: readonly DocumentFragment[];
  storyPreview?: AuthorStoryPreviewIdentity;
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

/** A point expressed relative to its source, not its current CSS size. */
export interface AuthorNormalizedPoint {
  x: number;
  y: number;
}

/** A rectangle expressed relative to its source, not its current CSS size. */
export interface AuthorNormalizedRect extends AuthorNormalizedPoint {
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

export interface AuthorStoryPreviewRectAnchor {
  kind: 'story-preview-rect';
  rect: AuthorNormalizedRect;
  preview: AuthorStoryPreviewIdentity;
}

export interface AuthorImagePointAnchor {
  kind: 'image-point';
  point: AuthorNormalizedPoint;
  naturalWidth: number;
  naturalHeight: number;
}

export interface AuthorPdfPagePointAnchor {
  kind: 'pdf-page-point';
  page: number;
  point: AuthorNormalizedPoint;
}

export interface AuthorVideoTimePointAnchor {
  kind: 'video-time-point';
  timeSeconds: number;
  point: AuthorNormalizedPoint;
  frame?: number;
  intrinsicWidth?: number;
  intrinsicHeight?: number;
}

export interface AuthorStoryPreviewPointAnchor {
  kind: 'story-preview-point';
  point: AuthorNormalizedPoint;
  preview: AuthorStoryPreviewIdentity;
}

export type AuthorRegionAnchor =
  | AuthorTextRangeAnchor
  | AuthorCellAnchor
  | AuthorSlideElementAnchor
  | AuthorImageRectAnchor
  | AuthorPdfPageRectAnchor
  | AuthorVideoTimeRectAnchor
  | AuthorStoryPreviewRectAnchor;

export type AuthorPointAnchor =
  | AuthorImagePointAnchor
  | AuthorPdfPagePointAnchor
  | AuthorVideoTimePointAnchor
  | AuthorStoryPreviewPointAnchor;

export type AuthorNativeAnchor = AuthorRegionAnchor | AuthorPointAnchor;

/** View state retained as capture evidence, never as mutation authority. */
export interface AuthorViewportSnapshot {
  width: number;
  height: number;
  originX?: number;
  originY?: number;
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

export type AuthorAnnotationMode = 'region' | 'point';
export type AuthorToolMode = 'select' | 'mark' | 'comment' | 'draw' | 'pan' | 'crop';

export interface AuthorAnnotationCandidate {
  documentPath: string;
  revision: number;
  sourceSha256?: string;
  mode?: AuthorAnnotationMode;
  quote?: string;
  anchor: AuthorNativeAnchor;
  /** Feedback-only source coordinates; never crop or mutation authority. */
  stroke?: readonly AuthorNormalizedPoint[];
  viewport: AuthorViewportSnapshot;
  voiceGrid?: AuthorVoiceGridEvidence;
  thumbnailUrl?: string;
  /** Durable capture evidence. Object URLs remain transient. */
  evidence?: Blob;
  createdAt: number;
}

export interface AuthorAnnotationDraft extends AuthorAnnotationCandidate {
  id: string;
  comment: string;
  /** Monotonically increases when the unsent annotation changes. */
  version?: number;
}

/** Compatibility names retained while region-only call sites migrate to mixed annotations. */
export type AuthorRegionCandidate = AuthorAnnotationCandidate;
export type AuthorRegionDraft = AuthorAnnotationDraft;

/** A region paired with the stable request/draft number shown in the document. */
export interface AuthorDisplayedRegion {
  ordinal: number;
  region: AuthorRegionDraft;
}
export type AuthorRequestStatus = 'REQUESTED' | 'CHANGING' | 'CHANGED' | 'COMPLETE' | 'FAILED' | 'CANCELLED';

export interface AuthorRequestRecord {
  id: string;
  captureId?: string;
  documentPath: string;
  requestText: string;
  regions: readonly AuthorRegionDraft[];
  pendingRegions?: readonly AuthorRegionDraft[];
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
