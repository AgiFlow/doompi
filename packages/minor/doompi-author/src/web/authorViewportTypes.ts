import type { AuthorJsonSchema } from '../types/author.ts';
import type { DocumentFragment, StructuredDocumentFormat } from '../types/structuredDocuments.ts';

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

export interface AuthorCrop {
  x: number;
  y: number;
  width: number;
  height: number;
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
