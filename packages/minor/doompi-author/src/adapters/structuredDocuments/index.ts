import type {
  CsvDialect,
  DocumentOperation,
  DocumentPreflightReport,
  ParsedStructuredDocument,
  SerializedStructuredDocument,
  StructuredDocumentFormat,
} from '../../types/structuredDocuments.ts';
import { parseCsv, preflightCsv, serializeCsv } from './csv.ts';
import { parseMarkdownSlides, preflightMarkdownSlides, serializeMarkdownSlides } from './markdownSlides.ts';
import { parsePptx, preflightPptx, serializePptx } from './pptx.ts';
import { parseXlsx, preflightXlsx, serializeXlsx } from './xlsx.ts';

export async function parseStructuredDocument(
  format: StructuredDocumentFormat,
  bytes: Uint8Array,
  csvDialect?: Partial<CsvDialect>,
): Promise<ParsedStructuredDocument> {
  if (format === 'markdown-slides') return parseMarkdownSlides(bytes);
  if (format === 'csv') return parseCsv(bytes, csvDialect);
  if (format === 'pptx') return await parsePptx(bytes);
  return await parseXlsx(bytes);
}

export async function preflightStructuredDocument(
  format: StructuredDocumentFormat,
  bytes: Uint8Array,
  operations: DocumentOperation[],
  csvDialect?: Partial<CsvDialect>,
): Promise<DocumentPreflightReport> {
  if (format === 'markdown-slides') return preflightMarkdownSlides(bytes, operations);
  if (format === 'csv') return preflightCsv(bytes, operations, csvDialect);
  if (format === 'pptx') return await preflightPptx(bytes, operations);
  return await preflightXlsx(bytes, operations);
}

export async function serializeStructuredDocument(
  format: StructuredDocumentFormat,
  bytes: Uint8Array,
  operations: DocumentOperation[],
  acceptedReportDigest: string,
  csvDialect?: Partial<CsvDialect>,
): Promise<SerializedStructuredDocument> {
  if (format === 'markdown-slides') return serializeMarkdownSlides(bytes, operations, acceptedReportDigest);
  if (format === 'csv') return serializeCsv(bytes, operations, acceptedReportDigest, csvDialect);
  if (format === 'pptx') return await serializePptx(bytes, operations, acceptedReportDigest);
  return await serializeXlsx(bytes, operations, acceptedReportDigest);
}

export { parseCsv, preflightCsv, serializeCsv } from './csv.ts';
export { parseMarkdownSlides, preflightMarkdownSlides, serializeMarkdownSlides } from './markdownSlides.ts';
export { readOoxmlArchive } from './ooxmlArchive.ts';
export { parsePptx, preflightPptx, serializePptx } from './pptx.ts';
export { parseXlsx, preflightXlsx, serializeXlsx } from './xlsx.ts';
