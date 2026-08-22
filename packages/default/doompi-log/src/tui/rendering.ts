import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export function fitLine(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), '');
}

export function padLine(text: string, width: number): string {
  const safeWidth = Math.max(0, width);
  const fitted = fitLine(text, safeWidth);
  return `${fitted}${' '.repeat(Math.max(0, safeWidth - visibleWidth(fitted)))}`;
}

export function frameLine(content: string, width: number, left = '│', right = '│'): string {
  const safeWidth = Math.max(0, width);
  const frameWidth = visibleWidth(left) + visibleWidth(right);
  if (safeWidth <= frameWidth) return fitLine(`${left}${right}`, safeWidth);
  return `${left}${padLine(content, safeWidth - frameWidth)}${right}`;
}
