import { createHash } from 'node:crypto';
import type {
  DocumentFragment,
  DocumentOperation,
  DocumentOperationLogEntry,
  DocumentPreflightIssue,
  DocumentPreflightReport,
  DocumentRenderModel,
  ParsedStructuredDocument,
  StructuredDocumentFormat,
} from '../../types/structuredDocuments.ts';

export const MAX_COMPRESSED_BYTES = 25 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
export const MAX_XML_ENTRY_BYTES = 10 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 4096;
export const MAX_COMPRESSION_RATIO = 100;

export function digestOf(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function parsedDocument(
  format: StructuredDocumentFormat,
  bytes: Uint8Array,
  fragments: DocumentFragment[],
  metadata: Record<string, string | number | boolean> = {},
): ParsedStructuredDocument {
  return {
    manifest: {
      format,
      sourceDigest: digestOf(bytes),
      byteLength: bytes.byteLength,
      fragmentCount: fragments.length,
      metadata,
    },
    fragments,
    renderModel: renderModel(format, fragments),
  };
}

function renderModel(format: StructuredDocumentFormat, fragments: DocumentFragment[]): DocumentRenderModel {
  return { format, blocks: fragments.map(({ id, text, readOnly }) => ({ id, text, readOnly: readOnly === true })) };
}

export function preflight(
  document: ParsedStructuredDocument,
  operations: DocumentOperation[],
  validate?: (operation: DocumentOperation, fragment: DocumentFragment) => DocumentPreflightIssue | undefined,
  binding?: unknown,
): DocumentPreflightReport {
  const fragments = new Map(document.fragments.map((fragment) => [fragment.id, fragment]));
  const seen = new Set<string>();
  const issues: DocumentPreflightIssue[] = [];
  const log: DocumentOperationLogEntry[] = [];
  let replacementBytes = 0;
  for (const operation of operations) {
    const fragment = fragments.get(operation.fragmentId);
    if (!fragment) {
      issues.push({
        code: 'unknown-fragment',
        message: 'The operation names an unknown fragment.',
        fragmentId: operation.fragmentId,
      });
      continue;
    }
    if (seen.has(operation.fragmentId)) {
      issues.push({
        code: 'duplicate-operation',
        message: 'A fragment may be replaced only once.',
        fragmentId: operation.fragmentId,
      });
      continue;
    }
    seen.add(operation.fragmentId);
    const operationBytes = new TextEncoder().encode(operation.replacement).byteLength;
    replacementBytes += operationBytes;
    if (operationBytes > MAX_XML_ENTRY_BYTES || replacementBytes > MAX_EXPANDED_BYTES) {
      issues.push({
        code: 'replacement-limit',
        message: 'Replacement content exceeds the document mutation limits.',
        fragmentId: operation.fragmentId,
      });
      continue;
    }
    if (fragment.readOnly === true) {
      issues.push({ code: 'read-only', message: 'The fragment is read-only.', fragmentId: operation.fragmentId });
      continue;
    }
    const issue = validate?.(operation, fragment);
    if (issue) issues.push(issue);
    else log.push({ ...operation, previous: fragment.text });
  }
  const digest = digestOf(
    JSON.stringify({
      format: document.manifest.format,
      binding,
      sourceDigest: document.manifest.sourceDigest,
      operations: log,
      issues,
    }),
  );
  return {
    accepted: issues.length === 0,
    digest,
    sourceDigest: document.manifest.sourceDigest,
    operations: log,
    issues,
  };
}

export function requireAccepted(report: DocumentPreflightReport, expectedDigest: string): void {
  if (!report.accepted || report.digest !== expectedDigest)
    throw new Error('An accepted, current preflight report digest is required.');
}

export function decodeUtf8(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('NUL bytes are not supported.');
  return text;
}
