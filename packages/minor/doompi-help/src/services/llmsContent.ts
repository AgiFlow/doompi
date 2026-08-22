import type { DoomHelpSkillDescriptor } from '@agimon-ai/doompi-extension-contracts/help';
import type { ResolvedHelpIndex } from '../types/help.ts';

export const MAX_LLMS_BYTES = 1024 * 1024;
export const MAX_AGGREGATE_LLMS_BYTES = 4 * MAX_LLMS_BYTES;

const MARKDOWN_LINK_PATTERN = /!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/gu;
const MARKDOWN_REFERENCE_LINK_PATTERN = /^\s{0,3}\[[^\]\r\n]+\]:\s*<?([^\s>]+)>?/gmu;
const MARKDOWN_AUTOLINK_PATTERN = /<((?:\.{0,2}\/|[A-Za-z][A-Za-z0-9+.-]*:)[^<>\s]+)>/gu;
const HTML_LINK_PATTERN = /\b(?:href|src)\s*=\s*["']([^"']+)["']/giu;
const URI_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/iu;
const NESTED_PATH_ENCODING_PATTERN = /%(?:25|2e|2f|3a|5c)/iu;
const SAFE_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function externalScheme(target: string): string | undefined {
  if (!URI_SCHEME_PATTERN.test(target)) return undefined;
  return target.slice(0, target.indexOf(':') + 1).toLowerCase();
}

function decodeRelativeTarget(rawTarget: string): string {
  let decoded = rawTarget;
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    throw new Error(`llms.txt contains an invalid encoded link '${rawTarget}'.`);
  }
  if (NESTED_PATH_ENCODING_PATTERN.test(decoded)) {
    throw new Error(`llms.txt contains an unsafe nested encoding in link '${rawTarget}'.`);
  }
  return decoded;
}

function validateRelativeLink(rawTarget: string): void {
  if (!rawTarget || rawTarget.startsWith('#')) return;
  const rawScheme = externalScheme(rawTarget);
  if (rawScheme) {
    if (!SAFE_EXTERNAL_SCHEMES.has(rawScheme)) {
      throw new Error(`llms.txt contains unsupported link scheme '${rawScheme}'.`);
    }
    return;
  }

  const decoded = decodeRelativeTarget(rawTarget);
  const decodedScheme = externalScheme(decoded);
  if (decodedScheme) {
    if (!SAFE_EXTERNAL_SCHEMES.has(decodedScheme)) {
      throw new Error(`llms.txt contains unsupported link scheme '${decodedScheme}'.`);
    }
    return;
  }
  const withoutSuffix = decoded.split(/[?#]/u, 1)[0]?.replaceAll('\\', '/') ?? '';
  if (withoutSuffix.startsWith('/') || withoutSuffix.split('/').some((segment) => segment === '..')) {
    throw new Error(`llms.txt link '${rawTarget}' escapes the package root.`);
  }
}

function containsUnsafeControl(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

export function validateLlmsBytes(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) throw new Error('llms.txt is empty.');
  if (bytes.byteLength > MAX_LLMS_BYTES) throw new Error(`llms.txt exceeds ${MAX_LLMS_BYTES} bytes.`);

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('llms.txt is not valid UTF-8.');
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  if (containsUnsafeControl(text)) throw new Error('llms.txt contains unsafe control bytes.');

  const firstContentLine = text
    .split(/\r?\n/u)
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (!firstContentLine || !/^#\s+\S/u.test(firstContentLine)) {
    throw new Error('llms.txt must begin with a Markdown H1 heading.');
  }
  for (const pattern of [
    MARKDOWN_LINK_PATTERN,
    MARKDOWN_REFERENCE_LINK_PATTERN,
    MARKDOWN_AUTOLINK_PATTERN,
    HTML_LINK_PATTERN,
  ]) {
    for (const match of text.matchAll(pattern)) validateRelativeLink(match[1] ?? '');
  }
  return text;
}

export function renderHelpSkillWrapper(descriptor: DoomHelpSkillDescriptor, index: ResolvedHelpIndex): string {
  const name = JSON.stringify(descriptor.name);
  const description = JSON.stringify(descriptor.description);
  const indexPath = JSON.stringify(index.filePath);
  const referenceBase = JSON.stringify(index.referenceBase);
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# Package Help\n\nRead the validated package Help index at ${indexPath}.\nResolve relative links in that index against ${referenceBase}.\nOpen only the linked documents relevant to the current request, as needed; do not recursively load the whole reference set.\n`;
}
