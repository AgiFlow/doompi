import path from 'node:path';
import { SaxesParser } from 'saxes';
import yauzl from 'yauzl';
import yazl from 'yazl';
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_COMPRESSED_BYTES,
  MAX_COMPRESSION_RATIO,
  MAX_EXPANDED_BYTES,
  MAX_XML_ENTRY_BYTES,
} from './common.ts';

export interface OoxmlArchiveEntry {
  name: string;
  data: Buffer;
  compressionMethod: number;
}

export interface OoxmlArchive {
  entries: OoxmlArchiveEntry[];
  byName: Map<string, OoxmlArchiveEntry>;
}

function normalizedEntryName(name: string): string {
  const slashName = name.replaceAll('\\', '/');
  if (slashName.startsWith('/') || /^[A-Za-z]:/.test(slashName))
    throw new Error('Absolute archive entry path rejected.');
  const normalized = path.posix.normalize(slashName);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('Archive path traversal rejected.');
  }
  return normalized.replace(/^\.\//, '');
}

function openArchive(bytes: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error || !zipFile) reject(error ?? new Error('Malformed ZIP archive.'));
      else resolve(zipFile);
    });
  });
}

function readEntry(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error('Could not read archive entry.'));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

function validateXml(name: string, data: Buffer): void {
  if (data.byteLength > MAX_XML_ENTRY_BYTES) throw new Error(`XML entry exceeds its size limit: ${name}`);
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(data);
  const withoutDeclaration = xml.replace(/^\uFEFF?\s*<\?xml\s[^?]*\?>/i, '');
  if (/<!DOCTYPE|<!ENTITY|<\?/i.test(withoutDeclaration)) throw new Error(`Unsafe XML construct rejected: ${name}`);
  const parser = new SaxesParser({ xmlns: true });
  let parseError: Error | undefined;
  parser.on('error', (error: Error) => {
    parseError = error;
  });
  parser.write(xml).close();
  if (parseError) throw new Error(`Malformed XML entry: ${name}`);
  if (/TargetMode\s*=\s*["']External["']/i.test(xml)) throw new Error('External OOXML relationship rejected.');
  if (/<(?:\w+:)?(?:workbookProtection|sheetProtection|documentProtection|modifyVerifier)\b/i.test(xml)) {
    throw new Error('Protected OOXML content rejected.');
  }
}

export async function readOoxmlArchive(source: Uint8Array): Promise<OoxmlArchive> {
  if (source.byteLength > MAX_COMPRESSED_BYTES) throw new Error('OOXML archive exceeds the compressed size limit.');
  const zipFile = await openArchive(Buffer.from(source));
  return await new Promise<OoxmlArchive>((resolve, reject) => {
    const entries: OoxmlArchiveEntry[] = [];
    const names = new Set<string>();
    let expanded = 0;
    const fail = (error: unknown): void => {
      zipFile.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    zipFile.once('error', fail);
    zipFile.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        if (entries.length >= MAX_ARCHIVE_ENTRIES) throw new Error('OOXML archive has too many entries.');
        if ((entry.generalPurposeBitFlag & 1) !== 0) throw new Error('Encrypted OOXML archive rejected.');
        if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('Archive symlink rejected.');
        if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
          throw new Error('Unsupported ZIP compression method.');
        const name = normalizedEntryName(entry.fileName);
        if (!name || names.has(name)) throw new Error('Duplicate normalized archive entry rejected.');
        names.add(name);
        expanded += entry.uncompressedSize;
        if (expanded > MAX_EXPANDED_BYTES) throw new Error('OOXML archive exceeds the expanded size limit.');
        if (entry.uncompressedSize > Math.max(1, entry.compressedSize) * MAX_COMPRESSION_RATIO) {
          throw new Error('OOXML archive compression ratio exceeds the limit.');
        }
        const lower = name.toLowerCase();
        if (
          lower === 'encryptedpackage' ||
          lower === 'encryptioninfo' ||
          lower.includes('vbaproject') ||
          lower.includes('_xmlsignatures') ||
          lower.endsWith('.bin')
        ) {
          throw new Error('Encrypted, signed, or macro-enabled OOXML content rejected.');
        }
        const data = name.endsWith('/') ? Buffer.alloc(0) : await readEntry(zipFile, entry);
        if (/\.xml$|\.rels$/i.test(name)) validateXml(name, data);
        entries.push({ name, data, compressionMethod: entry.compressionMethod });
        zipFile.readEntry();
      })().catch(fail);
    });
    zipFile.once('end', () => {
      if (!names.has('[Content_Types].xml')) {
        fail(new Error('Unsupported OOXML archive: missing content types.'));
        return;
      }
      resolve({ entries, byName: new Map(entries.map((entry) => [entry.name, entry])) });
    });
    zipFile.readEntry();
  });
}

export function assertOoxmlKind(archive: OoxmlArchive, kind: 'pptx' | 'xlsx'): void {
  const contentTypes = archive.byName.get('[Content_Types].xml')?.data.toString('utf8') ?? '';
  const required = kind === 'pptx' ? 'presentationml.presentation.main+xml' : 'spreadsheetml.sheet.main+xml';
  if (!contentTypes.includes(required))
    throw new Error(`Unsupported OOXML archive: not a ${kind.toUpperCase()} document.`);
  if (/macroEnabled|vnd\.ms-office\.vbaProject/i.test(contentTypes))
    throw new Error('Macro-enabled OOXML content rejected.');
}

export async function writeOoxmlArchive(
  archive: OoxmlArchive,
  replacements: ReadonlyMap<string, Buffer>,
): Promise<Uint8Array> {
  const zipFile = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  const output = new Promise<Buffer>((resolve, reject) => {
    zipFile.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zipFile.outputStream.once('error', reject);
    zipFile.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const entry of archive.entries) {
    if (entry.name.endsWith('/')) zipFile.addEmptyDirectory(entry.name);
    else
      zipFile.addBuffer(replacements.get(entry.name) ?? entry.data, entry.name, {
        compress: entry.compressionMethod === 8,
      });
  }
  zipFile.end();
  return await output;
}
