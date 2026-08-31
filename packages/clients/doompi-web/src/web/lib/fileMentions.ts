import { MEDIA_TYPES, type MediaKind } from '../../types/media.ts';

export interface FileMention {
  /** The cwd-relative path as the message spelled it. */
  path: string;
  /** How the timeline previews it; 'file' offers a link, 'directory' previews nothing. */
  kind: MediaKind | 'file' | 'directory';
}

// An @ token starts the message or follows whitespace, runs to the next
// whitespace, and sheds the punctuation a sentence hangs on it.
const MENTION = /(?:^|\s)@([^\s@]+)/gu;
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/u;

export function mediaKindFor(filePath: string): MediaKind | 'file' | 'directory' {
  // The trailing slash the @ completion writes for a folder. Naming one is
  // useful to the agent, but there is no asset behind it, and fetching one
  // only ever produced a "could not load" badge under the message.
  if (filePath.endsWith('/')) return 'directory';
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return 'file';
  return MEDIA_TYPES[filePath.slice(dot + 1).toLowerCase()]?.kind ?? 'file';
}

/** The distinct files a message mentions with @, in order of appearance. */
export function parseFileMentions(text: string): FileMention[] {
  const seen = new Set<string>();
  const mentions: FileMention[] = [];
  for (const match of text.matchAll(MENTION)) {
    const mentionPath = match[1].replace(TRAILING_PUNCTUATION, '');
    if (!mentionPath || seen.has(mentionPath)) continue;
    seen.add(mentionPath);
    mentions.push({ path: mentionPath, kind: mediaKindFor(mentionPath) });
  }
  return mentions;
}
