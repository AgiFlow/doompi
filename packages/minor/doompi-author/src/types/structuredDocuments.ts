export type StructuredDocumentFormat = 'markdown-slides' | 'csv' | 'pptx' | 'xlsx';

export interface DocumentManifest {
  format: StructuredDocumentFormat;
  sourceDigest: string;
  byteLength: number;
  fragmentCount: number;
  metadata: Record<string, string | number | boolean>;
}

export interface DocumentFragment {
  id: string;
  kind: 'slide' | 'cell' | 'text-run';
  text: string;
  readOnly?: boolean;
  location: string;
}

export interface DocumentRenderModel {
  format: StructuredDocumentFormat;
  blocks: Array<{ id: string; text: string; readOnly: boolean }>;
}

export interface DocumentOperation {
  fragmentId: string;
  replacement: string;
}

export interface DocumentOperationLogEntry extends DocumentOperation {
  previous: string;
}

export interface DocumentPreflightIssue {
  code: string;
  message: string;
  fragmentId?: string;
}

export interface DocumentPreflightReport {
  accepted: boolean;
  digest: string;
  sourceDigest: string;
  operations: DocumentOperationLogEntry[];
  issues: DocumentPreflightIssue[];
}

export interface ParsedStructuredDocument {
  manifest: DocumentManifest;
  fragments: DocumentFragment[];
  renderModel: DocumentRenderModel;
}

export interface SerializedStructuredDocument {
  bytes: Uint8Array;
  operationLog: DocumentOperationLogEntry[];
  manifest: DocumentManifest;
}

export interface CsvDialect {
  delimiter: ',' | ';' | '\t' | '|';
  quote: '"' | "'";
  recordDelimiter: '\n' | '\r\n';
}
