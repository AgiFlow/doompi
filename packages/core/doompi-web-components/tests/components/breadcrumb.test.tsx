import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BREADCRUMB_ELLIPSIS, Breadcrumb, breadcrumbSegments } from '../../src/exports/index.ts';

describe('breadcrumbSegments', () => {
  it('keeps a shallow path whole', () => {
    expect(breadcrumbSegments('src/app.ts')).toEqual(['src', 'app.ts']);
  });

  it('keeps a path exactly at the limit whole', () => {
    expect(breadcrumbSegments('a/b/c/d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('collapses the middle of a deep path, keeping the first segment and the leaf', () => {
    // `keep` counts what is shown, marker included, so four means four.
    expect(breadcrumbSegments('packages/core/web/src/components/Breadcrumb.tsx')).toEqual([
      'packages',
      BREADCRUMB_ELLIPSIS,
      'components',
      'Breadcrumb.tsx',
    ]);
  });

  it('honours a tighter limit', () => {
    expect(breadcrumbSegments('a/b/c/d/e', 3)).toEqual(['a', BREADCRUMB_ELLIPSIS, 'e']);
  });

  it('reads a bare file name as one segment', () => {
    expect(breadcrumbSegments('README.md')).toEqual(['README.md']);
  });

  it('ignores leading and doubled separators rather than showing empty segments', () => {
    expect(breadcrumbSegments('/src//app.ts')).toEqual(['src', 'app.ts']);
  });

  it('answers the input for an empty path rather than nothing at all', () => {
    expect(breadcrumbSegments('')).toEqual(['']);
  });
});

describe('Breadcrumb', () => {
  it('renders every segment of a shallow path with the leaf emphasised', () => {
    const markup = renderToStaticMarkup(<Breadcrumb path="src/app.ts" />);
    expect(markup).toContain('src');
    expect(markup).toContain('app.ts');
    expect(markup).toContain('font-bold');
  });

  it('shows the collapse marker for a deep path', () => {
    const markup = renderToStaticMarkup(<Breadcrumb path="a/b/c/d/e/f.ts" />);
    expect(markup).toContain(BREADCRUMB_ELLIPSIS);
    // The collapsed segments are not drawn, which is the point of collapsing.
    expect(markup).not.toContain('>b<');
  });

  it('truncates rather than wrapping in the trail itself', () => {
    const markup = renderToStaticMarkup(<Breadcrumb path="src/app.ts" />);
    expect(markup).toContain('truncate');
  });

  it('takes a testid and extra classes for the surface that places it', () => {
    const markup = renderToStaticMarkup(
      <Breadcrumb path="src/app.ts" data-testid="files-breadcrumb" className="w-40" />,
    );
    expect(markup).toContain('data-testid="files-breadcrumb"');
    expect(markup).toContain('w-40');
  });
});
