import type {
  DocumentOperation,
  DocumentPreflightReport,
  ParsedStructuredDocument,
  SerializedStructuredDocument,
} from '../../types/structuredDocuments.ts';
import { parsedDocument, preflight, requireAccepted } from './common.ts';
import { assertOoxmlKind, readOoxmlArchive, writeOoxmlArchive, type OoxmlArchive } from './ooxmlArchive.ts';
import { decodeXmlText, encodeXmlText, replaceRange } from './xmlText.ts';

interface PptxState {
  archive: OoxmlArchive;
  document: ParsedStructuredDocument;
  ranges: Map<string, { entry: string; start: number; end: number }>;
}

async function stateOf(source: Uint8Array): Promise<PptxState> {
  const archive = await readOoxmlArchive(source);
  assertOoxmlKind(archive, 'pptx');
  const fragments: ParsedStructuredDocument['fragments'] = [];
  const ranges = new Map<string, { entry: string; start: number; end: number }>();
  const slideEntries = archive.entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  for (const entry of slideEntries) {
    const xml = entry.data.toString('utf8');
    const paragraphs = xml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g);
    let runIndex = 0;
    for (const paragraph of paragraphs) {
      const body = paragraph[1] ?? '';
      const runCount = (body.match(/<a:r(?:\s[^>]*)?>/g) ?? []).length;
      const textCount = (body.match(/<a:t(?:\s[^>]*)?>/g) ?? []).length;
      if (textCount === 0) continue;
      if (runCount !== 1 || textCount !== 1) throw new Error('Unsupported PPTX paragraph with multiple text styles.');
      const textMatch = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/.exec(body);
      if (!textMatch) throw new Error('Malformed PPTX text run.');
      runIndex += 1;
      const id = `${entry.name}#text:${runIndex}`;
      const paragraphStart = paragraph.index ?? 0;
      const bodyOffset = paragraph[0].indexOf(body);
      const textOffset = body.indexOf(textMatch[1] ?? '', textMatch.index);
      const start = paragraphStart + bodyOffset + textOffset;
      const end = start + (textMatch[1]?.length ?? 0);
      fragments.push({ id, kind: 'text-run', text: decodeXmlText(textMatch[1] ?? ''), location: entry.name });
      ranges.set(id, { entry: entry.name, start, end });
    }
  }
  return { archive, document: parsedDocument('pptx', source, fragments, { slides: slideEntries.length }), ranges };
}

export async function parsePptx(source: Uint8Array): Promise<ParsedStructuredDocument> {
  return (await stateOf(source)).document;
}

export async function preflightPptx(
  source: Uint8Array,
  operations: DocumentOperation[],
): Promise<DocumentPreflightReport> {
  return preflight((await stateOf(source)).document, operations);
}

export async function serializePptx(
  source: Uint8Array,
  operations: DocumentOperation[],
  acceptedReportDigest: string,
): Promise<SerializedStructuredDocument> {
  const state = await stateOf(source);
  const report = preflight(state.document, operations);
  requireAccepted(report, acceptedReportDigest);
  const byEntry = new Map<string, Array<{ start: number; end: number; replacement: string }>>();
  for (const operation of report.operations) {
    const range = state.ranges.get(operation.fragmentId);
    if (!range) throw new Error('PPTX text run changed during serialization.');
    const list = byEntry.get(range.entry) ?? [];
    list.push({ start: range.start, end: range.end, replacement: encodeXmlText(operation.replacement) });
    byEntry.set(range.entry, list);
  }
  const replacements = new Map<string, Buffer>();
  for (const [entryName, edits] of byEntry) {
    let xml = state.archive.byName.get(entryName)?.data.toString('utf8') ?? '';
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
      xml = replaceRange(xml, edit.start, edit.end, edit.replacement);
    }
    replacements.set(entryName, Buffer.from(xml));
  }
  const bytes = await writeOoxmlArchive(state.archive, replacements);
  return { bytes, operationLog: report.operations, manifest: (await parsePptx(bytes)).manifest };
}
