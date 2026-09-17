import {
  isolatedPreviewHtml,
  normalizedAnnotationRect,
} from '../../src/extensions/workspaces/sessions/(frontend)/_lib/previewFrame';

describe('preview frame helpers', () => {
  it('inserts a restrictive policy into the document head', () => {
    const html = isolatedPreviewHtml('<!doctype html><html><head><title>Story</title></head><body /></html>');

    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("connect-src 'none'");
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('</head>'));
  });

  it('does not place the policy in a comment or script string', () => {
    const html = isolatedPreviewHtml(
      '<!doctype html><!-- <head> --><script>const text = "<head>";</script><html><head><title>Story</title></head></html>',
    );

    expect(html.indexOf('<!-- <head> -->')).toBeLessThan(html.indexOf('Content-Security-Policy'));
    expect(html.indexOf('Content-Security-Policy')).toBeGreaterThan(html.indexOf('<html><head>'));
  });
  it('creates a head when the bundle omits one', () => {
    expect(isolatedPreviewHtml('<!doctype html><button>Story</button>')).toMatch(
      /^<!doctype html><head><meta http-equiv="Content-Security-Policy"/,
    );
  });

  it('normalizes reverse drag coordinates', () => {
    const rect = normalizedAnnotationRect({ x: 0.8, y: 0.7 }, { x: 0.2, y: 0.1 });
    expect(rect).toMatchObject({ x: 0.2, y: 0.1 });
    expect(rect.width).toBeCloseTo(0.6);
    expect(rect.height).toBeCloseTo(0.6);
  });
});
