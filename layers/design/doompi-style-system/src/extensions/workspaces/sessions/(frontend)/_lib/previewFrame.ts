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

function findHeadInsertion(html: string): number | undefined {
  const lower = html.toLowerCase();
  let index = 0;
  while (index < html.length) {
    if (lower.startsWith('<!--', index)) {
      const end = lower.indexOf('-->', index + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[index] !== '<') {
      index += 1;
      continue;
    }
    const tag = html.slice(index).match(/^<([a-z][a-z0-9:-]*)(?:\s[^>]*)?>/i);
    if (tag === null) {
      index += 1;
      continue;
    }
    const name = tag[1]!.toLowerCase();
    const end = index + tag[0].length;
    if (name === 'head') return end;
    if (name === 'script' || name === 'style' || name === 'template' || name === 'textarea' || name === 'title') {
      const closing = lower.indexOf(`</${name}`, end);
      index = closing < 0 ? html.length : closing;
      continue;
    }
    index = end;
  }
  return undefined;
}

export function isolatedPreviewHtml(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const headInsertion = findHeadInsertion(html);
  if (headInsertion !== undefined) return `${html.slice(0, headInsertion)}${policy}${html.slice(headInsertion)}`;
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  if (doctype !== null) return `${doctype[0]}<head>${policy}</head>${html.slice(doctype[0].length)}`;
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

export function previewAnnotationLocation(
  tool: 'mark' | 'comment',
  start: PreviewPoint,
  end: PreviewPoint,
):
  | { mode: 'region'; point: PreviewPoint; rect: PreviewAnnotationRect }
  | { mode: 'point'; point: PreviewPoint }
  | null {
  if (tool === 'comment') return { mode: 'point', point: end };
  const rect = normalizedAnnotationRect(start, end);
  return rect.width === 0 || rect.height === 0 ? null : { mode: 'region', point: rect, rect };
}
