import { parse } from 'csv-parse/sync';
import type {
  CsvDialect,
  DocumentOperation,
  DocumentPreflightReport,
  ParsedStructuredDocument,
  SerializedStructuredDocument,
} from '../../types/structuredDocuments.ts';
import { decodeUtf8, MAX_COMPRESSED_BYTES, parsedDocument, preflight, requireAccepted } from './common.ts';

const FORMULA_TRIGGER = /^\s*[=+\-@]/;
const MAX_CELLS = 1_000_000;

function detectDialect(text: string): CsvDialect {
  const recordDelimiter = text.includes('\r\n') ? '\r\n' : '\n';
  const firstRecord = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiters: CsvDialect['delimiter'][] = [',', ';', '\t', '|'];
  const delimiter = delimiters.reduce((best, candidate) =>
    firstRecord.split(candidate).length > firstRecord.split(best).length ? candidate : best,
  );
  return { delimiter, quote: '"', recordDelimiter };
}

function normalizeDialect(text: string, requestedDialect?: Partial<CsvDialect>): CsvDialect {
  if (
    requestedDialect !== undefined &&
    (typeof requestedDialect !== 'object' || requestedDialect === null || Array.isArray(requestedDialect))
  ) {
    throw new Error('CSV dialect must be an object.');
  }
  const dialect = { ...detectDialect(text), ...requestedDialect } as Record<string, unknown>;
  if (![',', ';', '\t', '|'].includes(dialect.delimiter as string)) throw new Error('Invalid CSV delimiter.');
  if (!['"', "'"].includes(dialect.quote as string)) throw new Error('Invalid CSV quote.');
  if (!['\n', '\r\n'].includes(dialect.recordDelimiter as string)) throw new Error('Invalid CSV record delimiter.');
  return dialect as unknown as CsvDialect;
}

export function parseCsv(
  source: Uint8Array | string,
  requestedDialect?: Partial<CsvDialect>,
): ParsedStructuredDocument {
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source;
  if (bytes.byteLength > MAX_COMPRESSED_BYTES) throw new Error('CSV input exceeds the size limit.');
  const text = decodeUtf8(bytes);
  const dialect = normalizeDialect(text, requestedDialect);
  const records = parse(text, {
    bom: true,
    delimiter: dialect.delimiter,
    quote: dialect.quote,
    record_delimiter: [dialect.recordDelimiter],
    relax_column_count: false,
    skip_empty_lines: false,
  }) as string[][];
  const cellCount = records.reduce((total, row) => total + row.length, 0);
  if (cellCount > MAX_CELLS) throw new Error('CSV input has too many cells.');
  const fragments = records.flatMap((row, rowIndex) =>
    row.map((text, columnIndex) => {
      if (FORMULA_TRIGGER.test(text)) throw new Error(`CSV formula trigger rejected at row ${rowIndex + 1}.`);
      return {
        id: `cell:${rowIndex + 1}:${columnIndex + 1}`,
        kind: 'cell' as const,
        text,
        location: `row ${rowIndex + 1}, column ${columnIndex + 1}`,
      };
    }),
  );
  return parsedDocument('csv', bytes, fragments, {
    rows: records.length,
    columns: records.reduce((maximum, row) => Math.max(maximum, row.length), 0),
    delimiter: dialect.delimiter,
    quote: dialect.quote,
    recordDelimiter: dialect.recordDelimiter,
  });
}

export function preflightCsv(
  source: Uint8Array | string,
  operations: DocumentOperation[],
  dialect?: Partial<CsvDialect>,
): DocumentPreflightReport {
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source;
  const text = decodeUtf8(bytes);
  const normalizedDialect = normalizeDialect(text, dialect);
  return preflight(
    parseCsv(bytes, normalizedDialect),
    operations,
    (operation) =>
      FORMULA_TRIGGER.test(operation.replacement)
        ? {
            code: 'formula-trigger',
            message: 'CSV values may not begin with a formula trigger.',
            fragmentId: operation.fragmentId,
          }
        : undefined,
    { dialect: normalizedDialect },
  );
}

function encodeCell(value: string, dialect: CsvDialect): string {
  const escaped = value.replaceAll(dialect.quote, dialect.quote + dialect.quote);
  return value.includes(dialect.delimiter) || value.includes(dialect.quote) || /[\r\n]/.test(value)
    ? `${dialect.quote}${escaped}${dialect.quote}`
    : escaped;
}

export function serializeCsv(
  source: Uint8Array | string,
  operations: DocumentOperation[],
  acceptedReportDigest: string,
  requestedDialect?: Partial<CsvDialect>,
): SerializedStructuredDocument {
  const original = typeof source === 'string' ? source : decodeUtf8(source);
  const dialect = normalizeDialect(original, requestedDialect);
  const document = parseCsv(source, dialect);
  const report = preflightCsv(source, operations, dialect);
  requireAccepted(report, acceptedReportDigest);
  const replacements = new Map(report.operations.map((operation) => [operation.fragmentId, operation.replacement]));
  const fragments = new Map(document.fragments.map((fragment) => [fragment.id, fragment]));
  const rows = Number(document.manifest.metadata.rows);
  const columns = Number(document.manifest.metadata.columns);
  const outputRows: string[] = [];
  for (let row = 1; row <= rows; row += 1) {
    const values: string[] = [];
    for (let column = 1; column <= columns; column += 1) {
      const id = `cell:${row}:${column}`;
      const fragment = fragments.get(id);
      if (fragment) values.push(encodeCell(replacements.get(id) ?? fragment.text, dialect));
    }
    outputRows.push(values.join(dialect.delimiter));
  }
  const bytes = new TextEncoder().encode(outputRows.join(dialect.recordDelimiter));
  return { bytes, operationLog: report.operations, manifest: parseCsv(bytes, dialect).manifest };
}
