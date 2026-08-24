import { describe, expect, it } from 'vitest';
import { editCallView, editResultView, parseDiffRows, resultTextLines } from '../web/editToolView.ts';

describe('the edit call view', () => {
  it('counts ranges the way the TUI heading does', () => {
    expect(editCallView({ path: 'a.ts', edits: [{}, {}] })).toEqual({ path: 'a.ts', ranges: '2 ranges' });
    expect(editCallView({ path: 'a.ts', edits: [{}] })).toEqual({ path: 'a.ts', ranges: '1 range' });
    expect(editCallView({})).toEqual({ path: '', ranges: '0 ranges' });
  });
});

describe('the edit result view', () => {
  it("parses Pi's display diff into banded rows", () => {
    expect(parseDiffRows('-12 old\n+12 new\n 13 same\n     ...\nnot a row\t!')).toEqual([
      { marker: '-', lineNumber: '12', content: 'old' },
      { marker: '+', lineNumber: '12', content: 'new' },
      { marker: ' ', lineNumber: '13', content: 'same' },
      { marker: ' ', lineNumber: '', content: '...' },
      { marker: ' ', lineNumber: '', content: 'not a row  !' },
    ]);
  });

  it('takes the diff from the details and sizes the gutter from the widest number', () => {
    const view = editResultView({ content: [], details: { diff: '-9 a\n+100 b', patch: '' } });
    expect(view?.rows).toHaveLength(2);
    expect(view?.gutter).toBe(3);
    expect(editResultView({ content: [], details: { diff: '' } })).toBeUndefined();
    expect(editResultView({ content: [], details: undefined })).toBeUndefined();
    expect(editResultView(null)).toBeUndefined();
  });

  it('reads the message lines for a failed edit', () => {
    expect(
      resultTextLines({ content: [{ type: 'text', text: 'Stale hash\n' }, { type: 'image' }], details: undefined }, ''),
    ).toEqual(['Stale hash']);
    expect(resultTextLines(null, 'a\tb\r\nc')).toEqual(['a  b', 'c']);
  });
});
