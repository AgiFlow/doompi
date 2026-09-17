const PREVIEW_CSP =
  "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src data:; form-action 'none'; frame-src 'none'; img-src data: blob:; media-src data: blob:; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'";

export interface PreviewPoint {
  x: number;
  y: number;
}

export interface PreviewAnnotationRect extends PreviewPoint {
  width: number;
  height: number;
}

export function isolatedPreviewHtml(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${policy}`);
  if (/^<!doctype[^>]*>/i.test(html))
    return html.replace(/^<!doctype[^>]*>/i, (doctype) => `${doctype}<head>${policy}</head>`);
  return `<head>${policy}</head>${html}`;
}

export function normalizedAnnotationRect(start: PreviewPoint, end: PreviewPoint): PreviewAnnotationRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}
