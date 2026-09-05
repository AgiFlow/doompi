import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AUTHOR_DOCUMENT_MAX_BYTES,
  AUTHOR_DOCUMENT_OPEN_PATH,
  AUTHOR_DOCUMENT_SERIALIZE_PATH,
  createAuthorDocumentApi,
} from '../../src/adapters/authorDocumentApi.ts';
import { parseCsv, preflightCsv, serializeCsv } from '../../src/adapters/structuredDocuments/csv.ts';
import {
  parseMarkdownSlides,
  preflightMarkdownSlides,
  serializeMarkdownSlides,
} from '../../src/adapters/structuredDocuments/markdownSlides.ts';
import { readOoxmlArchive } from '../../src/adapters/structuredDocuments/ooxmlArchive.ts';
import { parsePptx, preflightPptx, serializePptx } from '../../src/adapters/structuredDocuments/pptx.ts';
import { parseXlsx, preflightXlsx, serializeXlsx } from '../../src/adapters/structuredDocuments/xlsx.ts';

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const FIXTURES = path.join(PACKAGE_ROOT, 'tests/fixtures/structured');

async function fixture(name: string): Promise<Buffer> {
  return await fs.readFile(path.join(FIXTURES, name));
}

describe('structured document adapters', () => {
  it('round-trips bounded Markdown slides through accepted preflight', () => {
    const source = '# One\n\n---\n\n# Two\n';
    const document = parseMarkdownSlides(source);
    expect(document.fragments.map((fragment) => fragment.text)).toEqual(['# One', '# Two']);
    const operations = [{ fragmentId: 'slide:2', replacement: '# Changed' }];
    const report = preflightMarkdownSlides(source, operations);
    const result = serializeMarkdownSlides(source, operations, report.digest);
    expect(Buffer.from(result.bytes).toString()).toContain('# Changed');
    expect(result.operationLog[0]?.previous).toBe('# Two');
  });

  it('preserves a CSV dialect and rejects formula triggers', () => {
    const source = 'name;note\r\nAda;hello';
    expect(parseCsv(source).manifest.metadata.delimiter).toBe(';');
    const rejected = preflightCsv(source, [{ fragmentId: 'cell:2:2', replacement: '  =cmd()' }]);
    expect(rejected.accepted).toBe(false);
    const operations = [{ fragmentId: 'cell:2:2', replacement: 'hello; world' }];
    const report = preflightCsv(source, operations);
    expect(Buffer.from(serializeCsv(source, operations, report.digest).bytes).toString()).toBe(
      'name;note\r\nAda;"hello; world"',
    );
  });

  it('binds CSV preflight to the normalized dialect and rejects invalid dialects', () => {
    const source = 'name,note\nAda,hello';
    const operations = [{ fragmentId: 'cell:2:2', replacement: 'updated' }];
    const lfReport = preflightCsv(source, operations, { recordDelimiter: '\n' });

    expect(() => serializeCsv(source, operations, lfReport.digest, { recordDelimiter: '\r\n' })).toThrow(
      'current preflight',
    );
    expect(
      Buffer.from(serializeCsv(source, operations, lfReport.digest, { recordDelimiter: '\n' }).bytes).toString(),
    ).toBe('name,note\nAda,updated');
    expect(() => parseCsv(source, { delimiter: ':' as ',' })).toThrow('Invalid CSV delimiter');
    expect(() => parseCsv(source, { recordDelimiter: '\r' as '\n' })).toThrow('Invalid CSV record delimiter');
  });
  it('replaces one PPTX text run and preserves untouched entry payloads', async () => {
    const source = await fixture('simple.pptx');
    const document = await parsePptx(source);
    expect(document.fragments).toMatchObject([{ text: 'Hello', kind: 'text-run' }]);
    const operations = [{ fragmentId: document.fragments[0]!.id, replacement: 'Goodbye' }];
    const report = await preflightPptx(source, operations);
    const output = await serializePptx(source, operations, report.digest);
    expect((await parsePptx(output.bytes)).fragments[0]?.text).toBe('Goodbye');
    expect((await readOoxmlArchive(output.bytes)).byName.get('marker.txt')?.data.toString()).toBe('untouched');
  });

  it('replaces an XLSX literal cell and leaves formula cells read-only', async () => {
    const source = await fixture('simple.xlsx');
    const document = await parseXlsx(source);
    expect(document.fragments.map(({ text, readOnly }) => ({ text, readOnly }))).toEqual([
      { text: 'Ada', readOnly: false },
      { text: '2', readOnly: true },
    ]);
    const denied = await preflightXlsx(source, [{ fragmentId: document.fragments[1]!.id, replacement: '3' }]);
    expect(denied.accepted).toBe(false);
    const operations = [{ fragmentId: document.fragments[0]!.id, replacement: 'Grace' }];
    const report = await preflightXlsx(source, operations);
    const output = await serializeXlsx(source, operations, report.digest);
    expect((await parseXlsx(output.bytes)).fragments[0]?.text).toBe('Grace');
  });

  it('keeps multi-run XLSX rich-text cells read-only and preserves their XML payload', async () => {
    const source = await fixture('rich-text.xlsx');
    const document = await parseXlsx(source);
    const richText = document.fragments.find((fragment) => fragment.text === 'Rich text')!;
    expect(richText.readOnly).toBe(true);
    await expect(preflightXlsx(source, [{ fragmentId: richText.id, replacement: 'flattened' }])).resolves.toMatchObject(
      {
        accepted: false,
        issues: [{ code: 'read-only', fragmentId: richText.id }],
      },
    );

    const editable = document.fragments.find((fragment) => fragment.text === 'Ada')!;
    const operations = [{ fragmentId: editable.id, replacement: 'Grace' }];
    const report = await preflightXlsx(source, operations);
    const output = await serializeXlsx(source, operations, report.digest);
    const richCell = '<c r="C1" t="inlineStr"><is><r><rPr><b/></rPr><t>Rich</t></r><r><t> text</t></r></is></c>';
    expect((await readOoxmlArchive(output.bytes)).byName.get('xl/worksheets/sheet1.xml')?.data.toString()).toContain(
      richCell,
    );
  });
  it('serves document views and bytes without writing the fixture', async () => {
    const original = await fixture('slides.md');
    const app = createAuthorDocumentApi({ cwd: PACKAGE_ROOT });
    const relativePath = 'tests/fixtures/structured/slides.md';
    const opened = await app.request(AUTHOR_DOCUMENT_OPEN_PATH, {
      method: 'POST',
      body: JSON.stringify({ path: relativePath, format: 'markdown-slides' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(((await opened.json()) as { manifest: { fragmentCount: number } }).manifest.fragmentCount).toBe(2);
    const operations = [{ fragmentId: 'slide:1', replacement: '# API' }];
    const report = preflightMarkdownSlides(original, operations);
    const serialized = await app.request(AUTHOR_DOCUMENT_SERIALIZE_PATH, {
      method: 'POST',
      body: JSON.stringify({
        path: relativePath,
        format: 'markdown-slides',
        operations,
        preflightDigest: report.digest,
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(serialized.status).toBe(200);
    expect(await fixture('slides.md')).toEqual(original);
  });
  it('rejects an oversized document before reading it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-author-'));
    try {
      const target = path.join(root, 'large.csv');
      await fs.writeFile(target, '');
      await fs.truncate(target, AUTHOR_DOCUMENT_MAX_BYTES + 1);
      const response = await createAuthorDocumentApi({ cwd: root }).request(AUTHOR_DOCUMENT_OPEN_PATH, {
        method: 'POST',
        body: JSON.stringify({ path: 'large.csv', format: 'csv' }),
        headers: { 'content-type': 'application/json' },
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({
        error: `Document exceeds the ${AUTHOR_DOCUMENT_MAX_BYTES} byte preview limit.`,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
