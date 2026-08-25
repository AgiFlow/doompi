import { describe, expect, it } from 'vitest';
import { mediaTypeFor, sessionFileHeaders } from '../../src/services/fileMedia.ts';

describe('mediaTypeFor', () => {
  it('classifies previewable media by extension, case-insensitively', () => {
    expect(mediaTypeFor('docs/shot.PNG')).toEqual({ kind: 'image', contentType: 'image/png' });
    expect(mediaTypeFor('a.mov')).toEqual({ kind: 'video', contentType: 'video/quicktime' });
    expect(mediaTypeFor('deck.pdf')).toEqual({ kind: 'pdf', contentType: 'application/pdf' });
    expect(mediaTypeFor('notes.txt')).toBeUndefined();
  });
});

describe('sessionFileHeaders', () => {
  it('serves previewable media inline with its content type', () => {
    expect(sessionFileHeaders('docs/shot.png')).toEqual({
      'Content-Type': 'image/png',
      'Content-Disposition': 'inline; filename="shot.png"',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  it('sandboxes svg, the one previewable type that can carry script', () => {
    expect(sessionFileHeaders('a.svg')['Content-Security-Policy']).toBe("default-src 'none'; sandbox");
    expect(sessionFileHeaders('a.png')['Content-Security-Policy']).toBeUndefined();
  });

  it('downloads anything else as an octet stream under its own name', () => {
    expect(sessionFileHeaders('src/x.ts')).toMatchObject({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="x.ts"',
    });
  });
});
