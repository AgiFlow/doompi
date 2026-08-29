import fs from 'node:fs';
import path from 'node:path';
import type { HubChannelSource, HubSessionScope, WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import { filterDoomIgnoredFiles } from '../services/doomIgnore.ts';
import { foldEntries, foldVersions, isDiffable, parseTimeline } from '../services/fileChanges.ts';
import { filesChannelType, type FilesItemView } from '../types/webFiles.ts';
import { FileEditPaths } from './FileEditPaths/FileEditPaths.ts';

/**
 * The changed-files channel: one watcher per managed session over the timeline
 * that session's extension appends to.
 *
 * The hub runs in its own process, so it reads what the extension wrote rather
 * than talking to it. Both halves derive the same path from the same session id
 * and working directory, which is what lets them meet on disk without an
 * agreement to keep in sync.
 *
 * Same reliability posture as this repository's other watchers: the poll is the
 * source of truth and fs.watch is only an accelerator, so a missed inotify
 * event costs latency rather than correctness, and a timeline that does not
 * exist yet (a session that has changed nothing) is a normal state.
 */

const POLL_MS = 2000;
const DEBOUNCE_MS = 120;

export interface FilesSource {
  close(): void;
}

export interface WatchFilesOptions {
  pollMs?: number;
  debounceMs?: number;
}

/** Whether the file is still there to be opened. */
function stillExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Reads one session's timeline and presents it as the rows the dock lists.
 *
 * A file the session changed and then removed is left out. The dock is a list
 * of things to open, and a row that can only ever answer "this is gone" is a
 * dead end; the timeline still holds the change, so a tab already open on the
 * file keeps working and says so.
 */
export function readSessionFiles(timelinePath: string, cwd: string): FilesItemView[] {
  let content: string;
  try {
    content = fs.readFileSync(timelinePath, 'utf8');
  } catch {
    return [];
  }
  const events = parseTimeline(content);
  const items = foldEntries(events)
    .filter((entry) => stillExists(entry.path))
    .map((entry) => ({
      path: entry.path,
      relPath: path.relative(cwd, entry.path) || entry.path,
      tool: entry.tool,
      at: entry.at,
      count: entry.count,
      diffable: isDiffable(foldVersions(events, entry.path)),
    }));

  try {
    const doomIgnore = fs.readFileSync(path.join(cwd, '.doomignore'), 'utf8');
    return filterDoomIgnoredFiles(items, doomIgnore);
  } catch {
    return items;
  }
}

/**
 * Watches one session's timeline and reports every change to its file list.
 * Announcements are deduped by fingerprint, so an unchanged list is silent.
 */
export function watchFiles(
  scope: HubSessionScope,
  onChange: (items: FilesItemView[]) => void,
  options: WatchFilesOptions = {},
): FilesSource {
  const paths = new FileEditPaths();
  let timelinePath: string;
  try {
    timelinePath = paths.timelinePath(scope.cwd, paths.sessionKey(scope.sessionId));
  } catch {
    // A working directory that cannot be resolved has no timeline to read; the
    // session simply reports nothing rather than taking the hub down with it.
    onChange([]);
    return { close: () => undefined };
  }

  let closed = false;
  let watcher: fs.FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  let lastEmitted: string | undefined;

  const emit = (): void => {
    if (closed) return;
    const items = readSessionFiles(timelinePath, scope.cwd);
    const fingerprint = JSON.stringify(items);
    if (fingerprint === lastEmitted) return;
    lastEmitted = fingerprint;
    onChange(items);
  };

  // The timeline file is created on the first change, so the watch is placed on
  // the directory that holds it and re-checked by the poll until it appears.
  const ensureWatcher = (): void => {
    if (watcher || closed) return;
    try {
      watcher = fs.watch(path.dirname(timelinePath), () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(emit, options.debounceMs ?? DEBOUNCE_MS);
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined; // The poll re-establishes it once the directory is back.
      });
    } catch {
      // The directory does not exist yet; the poll keeps trying.
    }
  };

  ensureWatcher();
  emit();
  const poll = setInterval(() => {
    ensureWatcher();
    emit();
  }, options.pollMs ?? POLL_MS);

  return {
    close() {
      closed = true;
      if (debounce) clearTimeout(debounce);
      clearInterval(poll);
      watcher?.close();
      watcher = undefined;
    },
  };
}

/**
 * The files data channel: one watcher per managed session, published as
 * { items } payloads under the 'file_edits' frame type.
 */
export function createFilesChannel(watch: typeof watchFiles = watchFiles): WebHubChannel {
  return {
    frameType: filesChannelType,
    start(host) {
      const latest = new Map<string, FilesItemView[]>();
      const sources = new Map<string, FilesSource>();
      const channelSource: HubChannelSource = {
        payloadFor(scope) {
          const items = latest.get(scope.sessionId);
          return items === undefined ? undefined : { items };
        },
        sessionAdded(scope) {
          sources.set(
            scope.sessionId,
            watch(scope, (items) => {
              latest.set(scope.sessionId, items);
              host.publish(scope.sessionId, { items });
            }),
          );
        },
        sessionRemoved(sessionId) {
          sources.get(sessionId)?.close();
          sources.delete(sessionId);
          latest.delete(sessionId);
        },
        close() {
          for (const source of sources.values()) source.close();
          sources.clear();
          latest.clear();
        },
      };
      return channelSource;
    },
  };
}

/** The named export the hub imports from the built entry the doompiWeb block names. */
export const webHubChannels: readonly WebHubChannel[] = [createFilesChannel()];
