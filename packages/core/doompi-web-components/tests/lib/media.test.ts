import { describe, expect, it } from 'vitest';
import { mediaKindOf } from '../../src/lib/media.ts';

describe('mediaKindOf', () => {
  it('names the element for each kind the browser can render', () => {
    expect(mediaKindOf('shot.png')).toBe('image');
    expect(mediaKindOf('clip.mp4')).toBe('video');
    expect(mediaKindOf('report.pdf')).toBe('pdf');
  });

  it('reads the extension whatever case it is written in', () => {
    expect(mediaKindOf('SHOT.PNG')).toBe('image');
    expect(mediaKindOf('Report.Pdf')).toBe('pdf');
  });

  it('offers a download for anything a browser cannot render', () => {
    // The formats the ask named: a converter is the only way to show these,
    // and a converted document is a different document.
    expect(mediaKindOf('notes.docx')).toBe('download');
    expect(mediaKindOf('budget.xlsx')).toBe('download');
    expect(mediaKindOf('bundle.zip')).toBe('download');
  });

  it('reads only the last suffix, and only inside the last path segment', () => {
    expect(mediaKindOf('src/assets/logo.min.svg')).toBe('image');
    // A directory that looks like an image does not make its contents one.
    expect(mediaKindOf('shots.png/readme')).toBe('download');
  });

  it('treats a file with no extension, and a dotfile, as a download', () => {
    expect(mediaKindOf('Makefile')).toBe('download');
    expect(mediaKindOf('.gitignore')).toBe('download');
    expect(mediaKindOf('')).toBe('download');
  });
});
