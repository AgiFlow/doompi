import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MentionPreviewAsset } from '../../src/web/features/session/MentionPreviews.tsx';
import type { SessionAsset } from '../../src/web/lib/sessionAsset.ts';

const asset = (contentType: string): SessionAsset => ({
  url: 'blob:sealed-file',
  contentType,
  dispose() {},
});

const renderAsset = (path: string, kind: 'image' | 'pdf' | 'file', contentType: string): string =>
  renderToStaticMarkup(createElement(MentionPreviewAsset, { mention: { path, kind }, asset: asset(contentType) }));

describe('MentionPreviewAsset', () => {
  it('shows SVG as a non-clickable image with an explicit download', () => {
    const markup = renderAsset('art/icon.svg', 'image', 'image/svg+xml');

    expect(markup).toContain('<img');
    expect(markup).not.toContain('<a href="blob:sealed-file" target="_blank"');
    expect(markup).toContain('href="blob:sealed-file" download="icon.svg"');
  });

  it('sandboxes PDF previews', () => {
    const markup = renderAsset('docs/report.pdf', 'pdf', 'application/pdf');

    expect(markup).toContain('<iframe');
    expect(markup).toContain('sandbox=""');
  });

  it('marks plain file links as downloads', () => {
    const markup = renderAsset('src/readme.txt', 'file', 'application/octet-stream');

    expect(markup).toContain('href="blob:sealed-file" download="readme.txt"');
  });
});
