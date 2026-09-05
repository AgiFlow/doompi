import type {
  DocumentOperation,
  DocumentPreflightReport,
  ParsedStructuredDocument,
  SerializedStructuredDocument,
} from '../../types/structuredDocuments.ts';
import { parsedDocument, preflight, requireAccepted } from './common.ts';
import { assertOoxmlKind, readOoxmlArchive, writeOoxmlArchive, type OoxmlArchive } from './ooxmlArchive.ts';
import { decodeXmlText, encodeXmlText, replaceRange } from './xmlText.ts';

interface CellRange {
  entry: string;
  start: number;
  end: number;
  attributes: string;
}

interface XlsxState {
  archive: OoxmlArchive;
  document: ParsedStructuredDocument;
  ranges: Map<string, CellRange>;
}

interface SharedString {
  text: string;
  multiRun: boolean;
}

function textNodes(xml: string): string {
  return [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)]
    .map((match) => decodeXmlText(match[1] ?? ''))
    .join('');
}

function sharedStrings(archive: OoxmlArchive): SharedString[] {
  const xml = archive.byName.get('xl/sharedStrings.xml')?.data.toString('utf8');
  if (!xml) return [];
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((match) => {
    const body = match[1] ?? '';
    return { text: textNodes(body), multiRun: [...body.matchAll(/<(?:\w+:)?r(?:\s[^>]*)?>/g)].length > 1 };
  });
}

function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`\\s${name}=["']([^"']*)["']`).exec(attributes)?.[1];
}

async function stateOf(source: Uint8Array): Promise<XlsxState> {
  const archive = await readOoxmlArchive(source);
  assertOoxmlKind(archive, 'xlsx');
  const shared = sharedStrings(archive);
  const fragments: ParsedStructuredDocument['fragments'] = [];
  const ranges = new Map<string, CellRange>();
  const worksheets = archive.entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  for (const entry of worksheets) {
    const xml = entry.data.toString('utf8');
    for (const match of xml.matchAll(/<c(\s[^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = match[1] ?? '';
      const body = match[2] ?? '';
      const reference = attribute(attributes, 'r');
      if (!reference) continue;
      const type = attribute(attributes, 't');
      const formula = /<f(?:\s[^>]*)?>[\s\S]*?<\/f>|<f\s*\/>/.test(body);
      const value = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
      let text: string;
      let multiRun = false;
      if (type === 's') {
        const index = Number(value);
        const sharedString = shared[index];
        if (!Number.isInteger(index) || sharedString === undefined)
          throw new Error(`Malformed shared string cell: ${reference}`);
        text = sharedString.text;
        multiRun = sharedString.multiRun;
      } else if (type === 'inlineStr') {
        text = textNodes(body);
        multiRun = [...body.matchAll(/<(?:\w+:)?r(?:\s[^>]*)?>/g)].length > 1;
      } else text = decodeXmlText(value);
      const id = `${entry.name}#cell:${reference}`;
      fragments.push({ id, kind: 'cell', text, readOnly: formula || multiRun, location: `${entry.name}!${reference}` });
      ranges.set(id, {
        entry: entry.name,
        start: match.index,
        end: match.index + match[0].length,
        attributes,
      });
    }
  }
  return { archive, document: parsedDocument('xlsx', source, fragments, { worksheets: worksheets.length }), ranges };
}

export async function parseXlsx(source: Uint8Array): Promise<ParsedStructuredDocument> {
  return (await stateOf(source)).document;
}

export async function preflightXlsx(
  source: Uint8Array,
  operations: DocumentOperation[],
): Promise<DocumentPreflightReport> {
  return preflight((await stateOf(source)).document, operations, (operation) =>
    /^\s*=/.test(operation.replacement)
      ? { code: 'formula-input', message: 'Formula input is not accepted.', fragmentId: operation.fragmentId }
      : undefined,
  );
}

export async function serializeXlsx(
  source: Uint8Array,
  operations: DocumentOperation[],
  acceptedReportDigest: string,
): Promise<SerializedStructuredDocument> {
  const state = await stateOf(source);
  const report = await preflightXlsx(source, operations);
  requireAccepted(report, acceptedReportDigest);
  const byEntry = new Map<string, Array<CellRange & { replacement: string }>>();
  for (const operation of report.operations) {
    const range = state.ranges.get(operation.fragmentId);
    if (!range) throw new Error('XLSX cell changed during serialization.');
    const list = byEntry.get(range.entry) ?? [];
    list.push({ ...range, replacement: operation.replacement });
    byEntry.set(range.entry, list);
  }
  const replacements = new Map<string, Buffer>();
  for (const [entryName, edits] of byEntry) {
    let xml = state.archive.byName.get(entryName)?.data.toString('utf8') ?? '';
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
      const attributes = edit.attributes.replace(/\st=["'][^"']*["']/, '') + ' t="inlineStr"';
      const cell = `<c${attributes}><is><t>${encodeXmlText(edit.replacement)}</t></is></c>`;
      xml = replaceRange(xml, edit.start, edit.end, cell);
    }
    replacements.set(entryName, Buffer.from(xml));
  }
  const bytes = await writeOoxmlArchive(state.archive, replacements);
  return { bytes, operationLog: report.operations, manifest: (await parseXlsx(bytes)).manifest };
}
