import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readJsonlTranscript } from '../../../../src/controllers/jsonlTranscriptReader';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('readJsonlTranscript', () => {
  it('reads the active v4 branch without modifying the journal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-jsonl-transcript-'));
    roots.push(root);
    const file = path.join(root, 'child.jsonl');
    const rows = [
      { kind: 'header', v: 4, storageVersion: 1, id: 'child', cwd: '/repo', createdAt: 1 },
      {
        kind: 'entry',
        seq: 1,
        timestamp: 1,
        type: 'message',
        id: 'user',
        parentId: null,
        message: { role: 'user', content: 'question', timestamp: 1 },
      },
      {
        kind: 'entry',
        seq: 2,
        timestamp: 2,
        type: 'message',
        id: 'assistant',
        parentId: 'user',
        message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: 2 },
      },
      { kind: 'value', seq: 3, op: 'set', namespace: 'pi.branch.tip', key: 'main', value: 'assistant' },
    ];
    const original = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
    fs.writeFileSync(file, original);

    const page = await readJsonlTranscript(file, {});

    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]).toMatchObject({ id: 'user' });
    expect(page.entries[1]).toMatchObject({ id: 'assistant' });
    expect(page.drafts).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readdirSync(root)).toEqual(['child.jsonl']);
  });

  it('rejects a torn journal without repairing it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-jsonl-transcript-'));
    roots.push(root);
    const file = path.join(root, 'child.jsonl');
    const original = JSON.stringify({ kind: 'header', v: 4, id: 'child' });
    fs.writeFileSync(file, original);

    await expect(readJsonlTranscript(file, {})).rejects.toThrow('incomplete');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});
