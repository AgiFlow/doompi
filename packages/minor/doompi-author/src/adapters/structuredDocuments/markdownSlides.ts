import type {
  DocumentOperation,
  DocumentPreflightReport,
  ParsedStructuredDocument,
  SerializedStructuredDocument,
} from '../../types/structuredDocuments.ts';
import { decodeUtf8, MAX_COMPRESSED_BYTES, parsedDocument, preflight, requireAccepted } from './common.ts';

const SLIDE_SEPARATOR = /^(?:---|\*\*\*)[ \t]*$/m;
const MAX_SLIDES = 1000;

export function parseMarkdownSlides(source: Uint8Array | string): ParsedStructuredDocument {
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source;
  if (bytes.byteLength > MAX_COMPRESSED_BYTES) throw new Error('Markdown input exceeds the size limit.');
  const text = decodeUtf8(bytes);
  const slides = text.split(SLIDE_SEPARATOR);
  if (slides.length > MAX_SLIDES) throw new Error('Markdown input has too many slides.');
  const fragments = slides.map((slide, index) => ({
    id: `slide:${index + 1}`,
    kind: 'slide' as const,
    text: slide.replace(/^\r?\n+|\r?\n+$/g, ''),
    location: `slide ${index + 1}`,
  }));
  return parsedDocument('markdown-slides', bytes, fragments, { slideCount: fragments.length });
}

export function preflightMarkdownSlides(
  source: Uint8Array | string,
  operations: DocumentOperation[],
): DocumentPreflightReport {
  return preflight(parseMarkdownSlides(source), operations);
}

export function serializeMarkdownSlides(
  source: Uint8Array | string,
  operations: DocumentOperation[],
  acceptedReportDigest: string,
): SerializedStructuredDocument {
  const document = parseMarkdownSlides(source);
  const report = preflight(document, operations);
  requireAccepted(report, acceptedReportDigest);
  const replacements = new Map(report.operations.map((operation) => [operation.fragmentId, operation.replacement]));
  const output = document.fragments
    .map((fragment) => replacements.get(fragment.id) ?? fragment.text)
    .join('\n\n---\n\n');
  const bytes = new TextEncoder().encode(output);
  return { bytes, operationLog: report.operations, manifest: parseMarkdownSlides(bytes).manifest };
}
