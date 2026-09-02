import type { SavedPrompt } from '../types/prompt.ts';

/**
 * The saved prompt document format.
 *
 * DESIGN PATTERNS:
 * - A saved prompt is an ordinary Pi prompt template: YAML frontmatter with a
 *   description, then the prompt body verbatim. Reusing that format is why
 *   `/<name>` works on the next start without this package registering anything.
 * - Pure string handling. The store owns paths and the filesystem.
 *
 * AVOID:
 * - A richer frontmatter surface. Anything this package invents here stops
 *   being a plain template that Pi can already read.
 */

const FRONTMATTER_FENCE = '---';
const DESCRIPTION_KEY = 'description:';
/** Keeps the picker's second column to one readable line. */
const DESCRIPTION_LIMIT = 80;
/** Filename and slash command in one, so the name has to be safe as both. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const NAME_LIMIT = 64;
/** Tokens Pi's template engine substitutes when the prompt is invoked. */
const ARGUMENT_TOKEN_PATTERN = /\$(?:\d|@|\{|ARGUMENTS)/u;

/** The pattern a saved prompt name must match, for user-facing messages. */
export const PROMPT_NAME_RULE = 'lowercase letters, digits and dashes, starting with a letter or digit';

export function isValidPromptName(name: string): boolean {
  return name.length <= NAME_LIMIT && NAME_PATTERN.test(name);
}

/** Whether Pi would substitute argument tokens into this text on invocation. */
export function hasArgumentTokens(text: string): boolean {
  return ARGUMENT_TOKEN_PATTERN.test(text);
}

/** The first non-empty line, shortened for the picker's description column. */
export function describePrompt(text: string): string {
  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return '';
  if (firstLine.length <= DESCRIPTION_LIMIT) return firstLine;
  return `${firstLine.slice(0, DESCRIPTION_LIMIT - 1).trimEnd()}…`;
}

/** Quotes the description so a colon or a quote cannot break the frontmatter. */
function quoteDescription(description: string): string {
  const flattened = description.replaceAll(/\s+/gu, ' ').trim();
  const escaped = flattened.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${escaped}"`;
}

function unquoteDescription(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) return trimmed;
  return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
}

export function buildPromptDocument(prompt: Pick<SavedPrompt, 'description' | 'text'>): string {
  const body = prompt.text.endsWith('\n') ? prompt.text : `${prompt.text}\n`;
  const description = prompt.description.trim();
  if (!description) return body;
  return [FRONTMATTER_FENCE, `description: ${quoteDescription(description)}`, FRONTMATTER_FENCE, body].join('\n');
}

/**
 * Splits a template back into its description and body.
 *
 * A document without frontmatter, or with frontmatter this package did not
 * write, is still a usable prompt: the whole file becomes the body and the
 * description falls back to the first line.
 */
export function parsePromptDocument(name: string, content: string): SavedPrompt {
  const normalized = content.replaceAll('\r\n', '\n');
  if (!normalized.startsWith(`${FRONTMATTER_FENCE}\n`)) {
    return { name, description: describePrompt(normalized), text: normalized.trim() };
  }

  const closing = normalized.indexOf(`\n${FRONTMATTER_FENCE}\n`, FRONTMATTER_FENCE.length);
  if (closing === -1) {
    return { name, description: describePrompt(normalized), text: normalized.trim() };
  }

  const frontmatter = normalized.slice(FRONTMATTER_FENCE.length + 1, closing);
  const body = normalized.slice(closing + FRONTMATTER_FENCE.length + 2).trim();
  const descriptionLine = frontmatter.split('\n').find((line) => line.trimStart().startsWith(DESCRIPTION_KEY));
  const description = descriptionLine
    ? unquoteDescription(descriptionLine.trimStart().slice(DESCRIPTION_KEY.length))
    : describePrompt(body);

  return { name, description, text: body };
}
