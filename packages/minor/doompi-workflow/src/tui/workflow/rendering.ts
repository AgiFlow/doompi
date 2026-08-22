import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

const THOUSAND = 1000;
const MILLION = 1_000_000;
/** Below this many tokens the "k" form keeps a decimal, above it rounds. */
const K_DECIMAL_LIMIT = 10_000;

/** Compact token count, e.g. `812`, `4.2k`, `186k`, `1.3M`. */
export function formatTokens(value: number): string {
  if (value < THOUSAND) return String(value);
  if (value < MILLION) return `${(value / THOUSAND).toFixed(value < K_DECIMAL_LIMIT ? 1 : 0)}k`;
  return `${(value / MILLION).toFixed(1)}M`;
}

export function fitLine(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), '');
}

export function padLine(text: string, width: number): string {
  const safeWidth = Math.max(0, width);
  const fitted = fitLine(text, safeWidth);
  return `${fitted}${' '.repeat(Math.max(0, safeWidth - visibleWidth(fitted)))}`;
}

export function alignLine(left: string, right: string, width: number): string {
  const safeWidth = Math.max(0, width);
  const rightWidth = visibleWidth(right);
  if (!right || rightWidth >= safeWidth) return fitLine(right || left, safeWidth);

  const maxLeftWidth = Math.max(0, safeWidth - rightWidth - 1);
  const fittedLeft = fitLine(left, maxLeftWidth);
  const gap = ' '.repeat(Math.max(1, safeWidth - visibleWidth(fittedLeft) - rightWidth));
  return fitLine(`${fittedLeft}${gap}${right}`, safeWidth);
}

export function frameLine(content: string, width: number, left = '│', right = '│'): string {
  const safeWidth = Math.max(0, width);
  const frameWidth = visibleWidth(left) + visibleWidth(right);
  if (safeWidth <= frameWidth) return fitLine(`${left}${right}`, safeWidth);
  return `${left}${padLine(content, safeWidth - frameWidth)}${right}`;
}

export function packSegments(segments: string[], width: number, separator = '  '): string[] {
  const safeWidth = Math.max(0, width);
  if (safeWidth === 0) return [];

  const lines: string[] = [];
  let current = '';
  for (const segment of segments) {
    const candidate = current ? `${current}${separator}${segment}` : segment;
    if (visibleWidth(candidate) <= safeWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(fitLine(current, safeWidth));
    current = fitLine(segment, safeWidth);
  }
  if (current) lines.push(current);
  return lines;
}
