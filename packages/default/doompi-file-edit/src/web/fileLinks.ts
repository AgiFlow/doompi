import type { FileLinkSource, TransientTab } from '@agimon-ai/doompi-web-contracts';
import type { FilesItemView } from '../types/webFiles.ts';
import { fileTab } from './FilePanel.tsx';
import { filePreviewTab } from './FilePreviewPanel.tsx';
import { files } from './filesStore.ts';

/**
 * The files a message names, as links into the same tab the activity dock
 * opens.
 *
 * Only files this session recorded a change to are claimed. A message quotes a
 * great deal that is shaped like nothing in particular, class names and globs
 * and flags among it, and guessing at what is a path produces links that open
 * an error. The recorded set is the one thing the page knows for certain, and
 * it is also the set a reader is most likely to want open.
 */

/** A reference the way a message writes one: 'src/app.ts:42' or 'src/app.ts:42:9'. */
const LINE_SUFFIX = /:\d+(?::\d+)?$/;

function itemsFor(sessionId: string | null): readonly FilesItemView[] {
  return files.select(files.store.state, sessionId).items;
}

function match(sessionId: string | null, path: string): FilesItemView | undefined {
  const candidate = path.trim().replace(LINE_SUFFIX, '');
  if (candidate === '') return undefined;
  return itemsFor(sessionId).find((item) => item.relPath === candidate || item.path === candidate);
}

export const fileLinks: FileLinkSource = {
  subscribe(listener: () => void) {
    const subscription = files.store.subscribe(listener);
    return () => subscription.unsubscribe();
  },
  // The paths themselves, not their count: a file that leaves the list while
  // another arrives changes what resolves without changing how many do.
  fingerprint: (sessionId) =>
    itemsFor(sessionId)
      .map((item) => item.relPath)
      .join('\n'),
  resolve: (sessionId, path): TransientTab | undefined => {
    const item = match(sessionId, path);
    return item === undefined ? undefined : fileTab(item.path, item.relPath);
  },
  // A tool argument is a path on purpose, so nothing here has to be guessed.
  // A file the session changed opens on its history; one it only read opens
  // read-only, and the route behind that tab is what decides whether a path
  // outside the working directory may be shown at all.
  openPath: (sessionId, path): TransientTab | undefined => {
    const item = match(sessionId, path);
    if (item !== undefined) return fileTab(item.path, item.relPath);
    // A call with no path argument at all hands this an empty string, and
    // there is no file to open behind it.
    const candidate = path.trim();
    return candidate === '' ? undefined : filePreviewTab(candidate);
  },
};
