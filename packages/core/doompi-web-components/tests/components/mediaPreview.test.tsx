import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MediaPreview } from '../../src/exports/index.ts';

const SRC = '/api/sessions/s1/file?path=docs%2Freport.pdf';

describe('MediaPreview', () => {
  it('renders an image inside a link to the full-size bytes', () => {
    const markup = renderToStaticMarkup(<MediaPreview src={SRC} path="docs/shot.png" />);
    expect(markup).toContain('<img');
    expect(markup).toContain('alt="docs/shot.png"');
    expect(markup).toContain(`href="${SRC}"`);
  });

  it('renders a video with controls rather than autoplaying it', () => {
    const markup = renderToStaticMarkup(<MediaPreview src={SRC} path="clip.mp4" />);
    expect(markup).toContain('<video');
    expect(markup).toContain('controls');
    expect(markup).not.toContain('autoplay');
  });

  it('renders a pdf in a frame titled with its path', () => {
    const markup = renderToStaticMarkup(<MediaPreview src={SRC} path="docs/report.pdf" />);
    expect(markup).toContain('<iframe');
    expect(markup).toContain('title="docs/report.pdf"');
  });

  it('offers anything else as a download named after the file', () => {
    const markup = renderToStaticMarkup(<MediaPreview src={SRC} path="notes/minutes.docx" />);
    expect(markup).toContain('download="minutes.docx"');
    expect(markup).toContain('download minutes.docx');
  });

  it('lets a caller that knows the kind override the guess from the path', () => {
    // A server may serve bytes under a name that says nothing, so the kind it
    // reports wins over the extension.
    const markup = renderToStaticMarkup(<MediaPreview src={SRC} path="attachment" kind="pdf" />);
    expect(markup).toContain('<iframe');
  });

  it('carries the test id and the kind, so a page can find and assert on it', () => {
    const markup = renderToStaticMarkup(<MediaPreview src={SRC} path="shot.png" data-testid="files-media" />);
    expect(markup).toContain('data-testid="files-media"');
    expect(markup).toContain('data-kind="image"');
  });
});
