/**
 * The text of a tool result, the way every tool card reads it: the `text`
 * content blocks joined with newlines, non-text blocks (images) dropped.
 */

const TAB = '\t';
const TAB_WIDTH = '  ';

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string'
  );
}

/** The text blocks of a result's content, joined with newlines. */
export function toolResultText(content: readonly unknown[]): string {
  return content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n');
}

/**
 * toolResultText as lines a card can count and clip: tabs widened, CRLF
 * folded, trailing blank lines dropped, and no lines at all for no text.
 */
export function toolResultTextLines(content: readonly unknown[]): string[] {
  const text = toolResultText(content);
  if (text.length === 0) return [];
  const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll(TAB, TAB_WIDTH).split('\n');
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop();
  return lines;
}
