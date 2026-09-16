import crypto from 'node:crypto';
import fs from 'node:fs';
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One recorded build input: the stat pair for speed, the digest for truth.
 *
 * Comparing only `size` and `mtimeMs` makes every rebuild look like a change,
 * including one that restored byte-identical output from a build cache, and a
 * sync triggered that way republishes a generation nobody asked for. Comparing
 * content alone is correct but reads every input on every check, and the
 * cockpit polls this. Recording both lets the stat pair answer the common
 * "nothing was touched" case without opening a file, while the digest stays the
 * authority for anything whose stat moved.
 */
export interface InputFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

/**
 * Verdicts already reached, so a rebuild that rewrote every input without
 * changing it does not re-hash the whole graph on every poll.
 *
 * Keyed by the stats actually found on disk, so it can never answer for a set
 * it did not see. Bounded by the compiler manifests in one composition, which
 * is single digits.
 */
const freshnessVerdicts = new Map<string, boolean>();

function digestOf(filePath: string): string | undefined {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    // Unreadable is indistinguishable from absent here: either way the recorded
    // digest cannot be confirmed, so the caller must treat the build as stale.
    return undefined;
  }
}

/** Records one build input, or undefined when it is not a readable regular file. */
export function fingerprintInput(target: string): InputFingerprint | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    // A path that vanished between discovery and recording is simply not an
    // input; the compiler records the set it could read.
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  const sha256 = digestOf(target);
  if (sha256 === undefined) return undefined;
  return { path: target, size: stat.size, mtimeMs: stat.mtimeMs, sha256 };
}

/** Parses one recorded input, rejecting a record written before digests existed. */
export function parseInputFingerprint(value: unknown): InputFingerprint | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.path !== 'string' ||
    typeof value.size !== 'number' ||
    typeof value.mtimeMs !== 'number' ||
    typeof value.sha256 !== 'string'
  ) {
    return undefined;
  }
  return { path: value.path, size: value.size, mtimeMs: value.mtimeMs, sha256: value.sha256 };
}

/** Whether every recorded input still holds the bytes it was recorded with. */
export function inputsAreFresh(inputs: readonly InputFingerprint[]): boolean {
  const moved: InputFingerprint[] = [];
  const key = crypto.createHash('sha256');
  for (const input of inputs) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(input.path);
    } catch {
      // A recorded input that is gone cannot be confirmed, and no digest will
      // bring it back; the build it describes is stale.
      return false;
    }
    if (!stat.isFile()) return false;
    key.update(`${input.path} ${String(stat.size)} ${String(stat.mtimeMs)} `);
    if (stat.size !== input.size || stat.mtimeMs !== input.mtimeMs) moved.push(input);
  }
  if (moved.length === 0) return true;

  const cacheKey = key.digest('hex');
  const remembered = freshnessVerdicts.get(cacheKey);
  if (remembered !== undefined) return remembered;
  const fresh = moved.every((input) => digestOf(input.path) === input.sha256);
  freshnessVerdicts.set(cacheKey, fresh);
  return fresh;
}

/** Test seam: the memo is process-local and must not leak between cases. */
export function resetInputFreshnessCache(): void {
  freshnessVerdicts.clear();
}
