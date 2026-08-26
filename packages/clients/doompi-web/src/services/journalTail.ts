import type { SessionFrame } from '../types/session.ts';

/** The entry type a journal line must carry to render; everything else is Pi's own bookkeeping. */
const MESSAGE_ENTRY_TYPE = 'message';
/** The frame the hub already replays journal entries as, so the page folds a thread with its one reducer. */
const ENTRY_APPENDED_TYPE = 'entry_appended';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One journal line as a renderable entry, or undefined for the header, bookkeeping, or a torn line. */
function parseEntry(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // A line the writer had not finished, or one that was never JSON: nothing to render from it.
    return undefined;
  }
  if (!isRecord(parsed) || parsed.type !== MESSAGE_ENTRY_TYPE) return undefined;
  // An entry without an id is the runtime's own bookkeeping; the page would skip it too.
  if (typeof parsed.id !== 'string' || parsed.id === '' || !isRecord(parsed.message)) return undefined;
  return parsed;
}

/**
 * Folds complete lines of a Pi session journal into the frames the cockpit
 * already renders for a live session: one entry_appended per message entry,
 * oldest first. The header, other entry types and unparsable lines are
 * skipped, so the page needs no second reducer for a thread.
 */
export function journalFrames(text: string): SessionFrame[] {
  const frames: SessionFrame[] = [];
  for (const line of text.split('\n')) {
    const entry = parseEntry(line);
    if (entry) frames.push({ type: ENTRY_APPENDED_TYPE, entry });
  }
  return frames;
}

/** The newest `limit` frames; a long journal gives up its oldest, as an attach does. */
export function retainNewest(frames: readonly SessionFrame[], limit: number): SessionFrame[] {
  return frames.length <= limit ? [...frames] : frames.slice(frames.length - limit);
}
