/**
 * Messages between a parent session and one worktree session.
 *
 * A two-party mirror of doompi-team's channel, kept private to this package
 * rather than imported: a layer must not depend on another layer, and two
 * parties need none of the membership, heartbeat or fanout machinery that makes
 * that module large.
 *
 * THE INVARIANTS WORTH COPYING, AND WHAT BREAKS WITHOUT THEM:
 *
 * 1. Write to a temp name and rename into place. A reader polling a directory
 *    will otherwise read a file that is still being written and parse half a
 *    message.
 * 2. Claim by rename before reading. Rename is atomic, so exactly one reader
 *    wins a message even when a session polls twice concurrently. Reading first
 *    and deleting after delivers the same message twice.
 * 3. Deliver, then delete. Deleting first loses the message permanently if the
 *    delivery throws; a duplicate is recoverable, a loss is not.
 * 4. A claim that outlives its reader is swept. Otherwise a crash mid-delivery
 *    strands the message in a claimed state nobody will ever look at again.
 *
 * AVOID:
 * - Treating an atomic write as a lock. It prevents a torn read, nothing else.
 * - Deleting a file that failed to parse. It may belong to a newer build, and
 *   destroying it turns a version skew into data loss.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const CHANNEL_MESSAGE_VERSION = 1;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MESSAGE_SUFFIX = '.json';
const CLAIM_PREFIX = '.claim-';
const MAX_MESSAGE_BYTES = 64 * 1024;
/** A claim older than this belonged to a reader that is not coming back. */
const CLAIM_STALE_MS = 60_000;

/** Which side of the pair a message is for. */
export type ChannelParty = 'parent' | 'child';

export interface ChannelMessage {
  version: typeof CHANNEL_MESSAGE_VERSION;
  /** Who sent it, so a reader never has to infer it from the directory. */
  from: ChannelParty;
  text: string;
  sentAt: string;
}

export interface WorktreeChannel {
  send(to: ChannelParty, text: string): void;
  /** Claims and returns everything waiting for a party, oldest first. */
  receive(as: ChannelParty): ChannelMessage[];
  /** Releases claims abandoned by a reader that died mid-delivery. */
  sweep(now?: number): number;
}

function inboxDirectory(root: string, party: ChannelParty): string {
  return path.join(root, party);
}

function parse(raw: string): ChannelMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Partial<ChannelMessage>;
  if (record.version !== CHANNEL_MESSAGE_VERSION) return undefined;
  if (record.from !== 'parent' && record.from !== 'child') return undefined;
  if (typeof record.text !== 'string' || record.text === '') return undefined;
  if (typeof record.sentAt !== 'string') return undefined;
  return { version: CHANNEL_MESSAGE_VERSION, from: record.from, text: record.text, sentAt: record.sentAt };
}

/** The channel rooted at a directory, created on demand. */
export function createWorktreeChannel(root: string): WorktreeChannel {
  return {
    send(to, text) {
      if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
        throw new Error(`A message may not exceed ${String(MAX_MESSAGE_BYTES)} bytes.`);
      }
      const directory = inboxDirectory(root, to);
      fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      const message: ChannelMessage = {
        version: CHANNEL_MESSAGE_VERSION,
        from: to === 'parent' ? 'child' : 'parent',
        text,
        sentAt: new Date().toISOString(),
      };
      // The random suffix, not just the timestamp: two messages sent in the
      // same millisecond would otherwise be one file, and the first would be
      // silently overwritten by the second.
      const name = `${String(Date.now()).padStart(14, '0')}-${randomBytes(6).toString('hex')}`;
      const temporary = path.join(directory, `.tmp-${name}`);
      fs.writeFileSync(temporary, JSON.stringify(message), { mode: PRIVATE_FILE_MODE });
      fs.renameSync(temporary, path.join(directory, `${name}${MESSAGE_SUFFIX}`));
    },

    receive(as) {
      const directory = inboxDirectory(root, as);
      let names: string[];
      try {
        names = fs.readdirSync(directory);
      } catch {
        return [];
      }
      const delivered: ChannelMessage[] = [];
      for (const name of names.filter((entry) => entry.endsWith(MESSAGE_SUFFIX)).sort()) {
        const claim = path.join(directory, `${CLAIM_PREFIX}${String(process.pid)}-${name}`);
        try {
          // Whoever wins this rename owns the message. A loser gets ENOENT and
          // simply moves on, which is why this is not wrapped in an existence
          // check: the check and the rename would not be atomic together.
          fs.renameSync(path.join(directory, name), claim);
        } catch {
          continue;
        }
        let message: ChannelMessage | undefined;
        try {
          message = parse(fs.readFileSync(claim, 'utf8'));
        } catch {
          message = undefined;
        }
        if (message === undefined) {
          // Left claimed rather than deleted. An unreadable message may come
          // from a newer build, and the sweep will surface it again rather than
          // this reader destroying something it did not understand.
          continue;
        }
        delivered.push(message);
        fs.rmSync(claim, { force: true });
      }
      return delivered;
    },

    sweep(now = Date.now()) {
      let released = 0;
      for (const party of ['parent', 'child'] as const) {
        const directory = inboxDirectory(root, party);
        let names: string[];
        try {
          names = fs.readdirSync(directory);
        } catch {
          continue;
        }
        for (const name of names.filter((entry) => entry.startsWith(CLAIM_PREFIX))) {
          const claimed = path.join(directory, name);
          try {
            if (now - fs.statSync(claimed).mtimeMs < CLAIM_STALE_MS) continue;
            // Returned to the inbox rather than deleted, because the message
            // was claimed but never delivered.
            const original = name.slice(name.indexOf('-', CLAIM_PREFIX.length) + 1);
            fs.renameSync(claimed, path.join(directory, original));
            released += 1;
          } catch {
            // Another sweeper got there first.
          }
        }
      }
      return released;
    },
  };
}
