/**
 * Parsing the YAML frontmatter block at the head of an agent or chain file.
 *
 * This is a deliberately partial YAML reader, not a call into a YAML library.
 * The block is read once, keys are kept as raw strings, and each consumer
 * interprets its own key. That is what lets an unrecognised key survive a
 * read/write round-trip: the loader copies it into `extraFields` verbatim
 * instead of losing it to a typed parse.
 *
 * DESIGN PATTERNS:
 * - Nested and folded blocks are captured as one string with newlines intact.
 *   A consumer that wants structure re-parses that string with a real YAML
 *   parser, so structural validation stays with the field that needs it
 * - Common leading whitespace is stripped from a block, so a serializer can
 *   re-indent to its own level without the original indent accumulating
 *
 * AVOID:
 * - Growing this into a general YAML parser; hand a block value to `yaml`
 *   instead
 * - Interpreting field semantics here
 */

const OPENING_FENCE = '---';
/** Length of the opening `---` fence, before the newline that follows it. */
const FENCE_LENGTH = OPENING_FENCE.length;
/** Length of the fence plus its trailing newline, used to slice past it. */
const FENCE_WITH_NEWLINE_LENGTH = FENCE_LENGTH + 1;
/** Offset of the first frontmatter character: past `---\n`. */
const FRONTMATTER_START_INDEX = FENCE_WITH_NEWLINE_LENGTH;
/** The closing fence as it appears mid-document, searched from after the opener. */
const CLOSING_FENCE = '\n---';

const FOLDED_BLOCK_INDICATORS = new Set(['>', '>-']);

/** Escape regex metacharacters so a literal string can be used in a RegExp. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fold a YAML folded block scalar.
 *
 * Folding joins lines with a space, except that more-indented lines and blank
 * separators are structural in YAML and must survive as real newlines. Getting
 * this wrong silently reflows a user's prompt, so the two cases are tracked
 * explicitly rather than approximated by a global replace.
 */
function foldBlock(block: string): string {
  let folded = '';
  let hasContent = false;
  let previousIsMoreIndented = false;
  let blankLines = 0;

  for (const line of block.split('\n')) {
    const current = line.trimEnd();
    if (current.trim() === '') {
      if (hasContent) blankLines++;
      continue;
    }

    const currentIsMoreIndented = current.length > current.trimStart().length;
    if (hasContent) {
      if (blankLines > 0) {
        folded += '\n'.repeat(blankLines + (previousIsMoreIndented || currentIsMoreIndented ? 1 : 0));
      } else {
        folded += previousIsMoreIndented || currentIsMoreIndented ? '\n' : ' ';
      }
    }
    folded += current;
    hasContent = true;
    previousIsMoreIndented = currentIsMoreIndented;
    blankLines = 0;
  }

  return folded.trim();
}

/**
 * Read a list-valued field written either comma-separated or as a block list.
 *
 * Only a leading `- ` marker is treated as a list bullet. A bare hyphen inside
 * a value is left alone, so hyphenated names like `context-builder` survive.
 */
export function parseFrontmatterList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split('\n')
    .flatMap((line) => {
      const value = line.trim();
      const listItem = value.match(/^-\s+(.+)$/);
      return (listItem?.[1] ?? value).split(',');
    })
    .map((value) => value.trim())
    .filter(Boolean);
}

/** A frontmatter block reduced to raw string values, plus the body after it. */
export interface ParsedFrontmatter {
  frontmatter: Record<string, string>;
  body: string;
}

/** Strip the block's common leading whitespace so it can be re-indented later. */
function dedentBlock(blockLines: string[]): string {
  const rawBlock = blockLines.join('\n');
  const leadingSpaces = rawBlock.match(/^[ \t]+(?=\S)/m);
  const prefix = leadingSpaces?.[0] ?? '';
  if (!prefix) return rawBlock;
  return rawBlock.replace(new RegExp(`^${escapeRegex(prefix)}`, 'gm'), '').replace(/^\n/, '');
}

/**
 * Split a file into its frontmatter map and its body.
 *
 * A file with no opening fence, or with an unterminated one, is treated as all
 * body with empty frontmatter. The loader then rejects it for want of a name,
 * which is the right outcome: a malformed file should be skipped, not crash a
 * directory sweep.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const frontmatter: Record<string, string> = {};
  const normalized = content.replace(/\r\n/g, '\n');

  if (!normalized.startsWith(OPENING_FENCE)) {
    return { frontmatter, body: normalized };
  }

  const endIndex = normalized.indexOf(CLOSING_FENCE, FENCE_LENGTH);
  if (endIndex === -1) {
    return { frontmatter, body: normalized };
  }

  const frontmatterBlock = normalized.slice(FRONTMATTER_START_INDEX, endIndex);
  const body = normalized.slice(endIndex + FENCE_WITH_NEWLINE_LENGTH).trim();

  let currentKey: string | null = null;
  let currentBlockLines: string[] | null = null;
  let currentIndent: number | null = null;
  let currentFolded = false;

  const flushBlock = (): void => {
    if (currentKey === null || currentBlockLines === null) return;
    const stripped = dedentBlock(currentBlockLines);
    frontmatter[currentKey] = currentFolded ? foldBlock(stripped) : stripped;
    currentKey = null;
    currentBlockLines = null;
    currentIndent = null;
    currentFolded = false;
  };

  for (const line of frontmatterBlock.split('\n')) {
    const indent = line.search(/\S|$/);
    const trimmed = line.trim();

    // A line indented past its key belongs to that key's block. A folded block
    // also absorbs blank lines, because they are its paragraph separators.
    if (
      currentKey !== null &&
      currentBlockLines !== null &&
      (indent > (currentIndent ?? 0) || (currentFolded && trimmed === ''))
    ) {
      currentBlockLines.push(line);
      continue;
    }

    flushBlock();

    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (!match) continue; // Comments and blank lines carry no field.

    const key = match[1] ?? '';
    const rawValue = (match[2] ?? '').trim();
    const isQuoted =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"));
    const value = isQuoted ? rawValue.slice(1, -1) : rawValue;
    const isFolded = !isQuoted && FOLDED_BLOCK_INDICATORS.has(rawValue);

    if (value === '' || isFolded) {
      // The value has not arrived yet; it is whatever indents under this key.
      currentKey = key;
      currentBlockLines = [];
      currentIndent = indent;
      currentFolded = isFolded;
    } else {
      frontmatter[key] = value;
    }
  }

  flushBlock();

  return { frontmatter, body };
}
