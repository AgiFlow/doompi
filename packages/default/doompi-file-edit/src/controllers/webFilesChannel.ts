import fs from 'node:fs';
import path from 'node:path';
import type { DoomHubChannel, DoomHubChannelSource } from '@agimon-ai/doompi-extension-contracts/hub-channel';
import { filterDoomIgnoredFiles } from '../services/doomIgnore';
import { confirmedChanges, foldEntries, foldVersions, isDiffable, parseTimeline } from '../services/fileChanges';
import { filesChannelType, type FilesItemView } from '../types/webFiles';
import { FileEditPaths } from '../services/fileEditPaths';

/**
 * The changed-files channel consumes snapshots emitted by the owning session
 * facet. Durable timeline reads seed a channel that starts after session startup.
 */

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
 * A file the session changed and then removed is left out, and so is a path a
 * bash call only touched: a command that moves a modification time without
 * changing a byte is not an edit, and listing it buries the ones that are. The
 * dock is a list of things to open, and a row that can only ever answer "this
 * is gone" is a dead end; the timeline still holds the change, so a tab already
 * open on the file keeps working and says so.
 */
export function readSessionFiles(timelinePath: string, cwd: string): FilesItemView[] {
  let content: string;
  try {
    content = fs.readFileSync(timelinePath, 'utf8');
  } catch {
    return [];
  }
  const events = confirmedChanges(parseTimeline(content));
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

function filesPayload(value: unknown): value is { items: FilesItemView[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { items?: unknown }).items);
}

/**
 * The files data channel: one direct-event subscription per managed session,
 * published as { items } payloads under the 'file_edits' frame type.
 */
export function createFilesChannel(): DoomHubChannel {
  return {
    frameType: filesChannelType,
    start(host) {
      const latest = new Map<string, FilesItemView[]>();
      const subscriptions = new Map<string, () => void>();
      const paths = new FileEditPaths();
      const channelSource: DoomHubChannelSource = {
        payloadFor(scope) {
          const items = latest.get(scope.sessionId);
          return items === undefined ? undefined : { items };
        },
        sessionAdded(scope) {
          subscriptions.get(scope.sessionId)?.();
          let timelinePath: string | undefined;
          try {
            timelinePath = paths.timelinePath(scope.cwd, paths.sessionKey(scope.sessionId));
          } catch {
            // The session has no readable state path yet.
          }
          const items = timelinePath === undefined ? [] : readSessionFiles(timelinePath, scope.cwd);
          latest.set(scope.sessionId, items);
          host.publish(scope.sessionId, { items });
          const unsubscribe = host.directEvents.subscribe(
            filesChannelType,
            scope.sessionId,
            (payload) => {
              if (!filesPayload(payload)) return;
              latest.set(scope.sessionId, payload.items);
              host.publish(scope.sessionId, payload);
            },
            { replayLatest: true },
          );
          subscriptions.set(scope.sessionId, unsubscribe);
        },
        sessionRemoved(sessionId) {
          subscriptions.get(sessionId)?.();
          subscriptions.delete(sessionId);
          latest.delete(sessionId);
        },
        close() {
          for (const unsubscribe of subscriptions.values()) unsubscribe();
          subscriptions.clear();
          latest.clear();
        },
      };
      return channelSource;
    },
  };
}
