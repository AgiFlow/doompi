import path from 'node:path';
import { lineDiff, lineDiffFromEmpty } from '../../services/lineDiff.ts';
import type { FileEditTool, TimelineEvent } from '../../types/domain';
import type { IEditTracker } from '../../types/editTracker';
import type { GitStatusPort } from '../../types/gitStatus.ts';
import type { SnapshotStorePort } from '../../types/snapshotStore.ts';
import type { ITimelineStore } from '../../types/timelineStore';
import type { TreeManifest, TreeManifestPort } from '../../types/treeManifest.ts';

const EDIT_TOOL = 'edit';
const WRITE_TOOL = 'write';
const BASH_TOOL = 'bash';

/**
 * Records what the session changed, and captures enough of it to be diffed.
 *
 * Two mechanisms, because one is not enough. `edit` and `write` name their file
 * in the call arguments, so the content is read before the tool runs and both
 * sides of the change are known exactly. `bash` names nothing reliable: the
 * agent can write a script and run it, and reading path-shaped tokens out of
 * the command would miss every file that script touches. So a bash call is
 * bracketed by tree manifests instead, and whatever moved between them is
 * recorded, however it was written.
 *
 * A manifest-found path is recorded without a baseline, because it was only
 * identified after it had already changed. That is a real limit and the wire
 * carries it as `origin: 'scan'` rather than pretending a diff exists.
 *
 * A manifest compares size and modification time, and it compares the tree as
 * this tracker last walked it against the tree now, so it answers whether a
 * file differs, never when it moved. A path a previous session left dirty, or
 * one a checkout or an install rewrote, differs exactly like a path the command
 * just wrote. So a candidate is called verified only when something actually
 * proves its bytes moved: it appeared, it vanished, its recorded size differs,
 * or its content hash differs from one this session already took. Absence of
 * proof is not proof, so a candidate that shows none of those is still
 * recorded, because the timeline is the evidence, but it goes out unverified
 * and every surface leaves it out.
 */
interface PendingEdit {
  tool: 'edit' | 'write';
  filePath: string;
  before: string | undefined;
  /**
   * Whether the file was there when the call began. A missing `before` cannot
   * say on its own: content is left uncaptured both for a file that does not
   * exist and for one too large or too binary to store.
   */
  existed: boolean;
}

function objectValue(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found : undefined;
}

export interface EditTrackerOptions {
  /** Injectable so a test can pin the recorded timestamps. */
  now?: () => number;
  /**
   * Decides whether a first-seen scan candidate actually changed. Optional:
   * without it the tracker keeps recording every candidate it cannot disprove.
   */
  git?: GitStatusPort;
}

/**
 * How far before a call started a write may claim to have happened and still be
 * attributed to it. A working tree can sit on a filesystem that stores whole
 * seconds, which floors a write made just after the call began to a stamp just
 * before it, and the cost of being generous here is one second of the staleness
 * this check exists to remove.
 */
const MODIFIED_TOLERANCE_MS = 1000;

export class EditTracker implements IEditTracker {
  private readonly pending = new Map<string, PendingEdit>();
  /** Start time per in-flight bash call, so its end knows what it may claim. */
  private readonly bracketed = new Map<string, number>();
  /**
   * The tree as this tracker last saw it. A bash call compares against it and
   * then replaces it, so each call costs one walk rather than two, and a change
   * made between calls is still noticed on the next one.
   */
  private manifest: TreeManifest | undefined;
  /**
   * This package's own storage, which the walk must never report. The timeline
   * and its snapshots can land inside the tree being watched, and recording
   * them would make every change cause another one.
   */
  private excluded: readonly string[] = [];
  /**
   * The project's own ignore rules. A path the project disowns is not worth a
   * git call, a read, or a stored copy of its content, so it is dropped before
   * it costs any of them.
   */
  private isIgnored: ((filePath: string) => boolean) | undefined;
  /**
   * The last content hash this session saw per path, from either mechanism.
   * A candidate whose hash has not moved was touched, not edited.
   */
  private readonly contents = new Map<string, string>();
  private readonly now: () => number;
  private readonly git: GitStatusPort | undefined;

  constructor(
    private readonly timeline: ITimelineStore,
    private readonly snapshots: SnapshotStorePort,
    private readonly manifests: TreeManifestPort,
    options: EditTrackerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.git = options.git;
  }

  /**
   * Forgets the previous session's tree so a new one does not inherit its
   * baseline, and takes the paths this session's own bookkeeping occupies.
   */
  reset(options: { exclude?: readonly string[]; isIgnored?: (filePath: string) => boolean } = {}): void {
    this.pending.clear();
    this.bracketed.clear();
    this.contents.clear();
    this.manifest = undefined;
    this.excluded = options.exclude ?? [];
    this.isIgnored = options.isIgnored;
  }

  async start(id: string, tool: string, args: unknown, cwd: string): Promise<void> {
    if (tool === EDIT_TOOL || tool === WRITE_TOOL) {
      const supplied = objectValue(args, 'path');
      if (!supplied) return;
      const filePath = path.resolve(cwd, supplied);
      // Both are read before the tool runs. The fingerprint is the only thing
      // that tells a file being created from one whose content could not be
      // captured, because a capture answers undefined for either.
      const [before, fingerprint] = await Promise.all([
        this.snapshots.capture(filePath),
        this.manifests.fingerprint(filePath),
      ]);
      this.pending.set(id, { tool, filePath, before, existed: fingerprint !== undefined });
      return;
    }
    if (tool !== BASH_TOOL) return;
    // Read before the baseline walk, which is the one thing here that can take
    // long enough to matter: a write that races it belongs to this call.
    this.bracketed.set(id, this.now());
    // The first bash call of a session has nothing to compare against, so it
    // pays for the baseline walk; every later call reuses the previous end.
    this.manifest ??= await this.manifests.take(cwd, this.excluded);
  }

  async end(id: string, isError: boolean, cwd: string): Promise<void> {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    const startedAt = this.bracketed.get(id);
    this.bracketed.delete(id);
    if (pending) {
      // A failed edit or write never landed, and its arguments named the file,
      // so there is nothing left to look for.
      if (!isError) await this.recordTool(pending);
      return;
    }
    // A failed command may still have written before it failed. Skipping the
    // walk would leave the baseline stale and hand those writes to whichever
    // call closes next.
    if (startedAt !== undefined) await this.recordScan(cwd, startedAt);
  }

  /** An `edit` or `write` whose file was read on both sides of the call. */
  private async recordTool(pending: PendingEdit): Promise<void> {
    const after = await this.snapshots.capture(pending.filePath);
    const created = !pending.existed;
    const counts = await this.countChanges(pending.before, after, created);
    if (after !== undefined) this.contents.set(pending.filePath, after);
    await this.append({
      version: 2,
      path: pending.filePath,
      tool: pending.tool,
      at: this.now(),
      origin: 'tool',
      ...(pending.before === undefined ? {} : { before: pending.before }),
      ...(after === undefined ? {} : { after }),
      ...(created ? { created: true } : {}),
      ...counts,
    });
    // The tool already accounted for this path, so the next bash comparison
    // must not report it a second time under its own name.
    await this.remember(pending.filePath);
  }

  /** Whatever a bash call actually edited, however the command wrote it. */
  private async recordScan(cwd: string, startedAt: number): Promise<void> {
    const before = this.manifest;
    if (before === undefined) return;
    const after = await this.manifests.take(cwd, this.excluded);
    this.manifest = after;
    const disowned = this.isIgnored;
    const named = this.manifests
      .changed(before, after)
      .filter((filePath) => disowned === undefined || !disowned(filePath));
    const candidates = await this.writtenDuring(named, startedAt);
    if (candidates.length === 0) return;
    const unchanged = await this.unchangedInGit(cwd, candidates);
    for (const filePath of candidates) {
      const known = this.contents.get(filePath);
      // Asked before the file is read: a path git vouches for is worth neither
      // the read nor the stored copy that reading it leaves behind.
      if (known === undefined && unchanged.has(filePath)) continue;
      const beforePrint = before.entries.get(filePath);
      const afterPrint = after.entries.get(filePath);
      // A path that is gone has nothing to read, and reading it back would only
      // confirm that.
      const captured = afterPrint === undefined ? undefined : await this.snapshots.capture(filePath);
      if (captured !== undefined) this.contents.set(filePath, captured);
      // The bytes are the ones this session already recorded: the call moved the
      // modification time and nothing else.
      if (captured !== undefined && captured === known) continue;
      const proven =
        beforePrint === undefined ||
        afterPrint === undefined ||
        this.manifests.sizeChanged(beforePrint, afterPrint) ||
        (known !== undefined && captured !== undefined && captured !== known);
      await this.append({
        version: 2,
        path: filePath,
        tool: BASH_TOOL,
        at: this.now(),
        origin: 'scan',
        ...(proven ? { verified: true } : {}),
        ...(captured === undefined ? {} : { after: captured }),
      });
    }
  }

  /**
   * Narrows candidates to the ones that could have been written by the call
   * being closed.
   *
   * This is what keeps a working tree that was already dirty out of the list. A
   * file whose bytes were last written before the call began was differed by
   * something else, whatever moved its fingerprint. A file that is no longer
   * there has no time to read and a delete is a change the call may well have
   * made, so it stays a candidate.
   */
  private async writtenDuring(candidates: readonly string[], startedAt: number): Promise<string[]> {
    const floor = startedAt - MODIFIED_TOLERANCE_MS;
    const written: string[] = [];
    for (const filePath of candidates) {
      const modifiedAt = await this.manifests.modifiedAt(filePath);
      if (modifiedAt === undefined || modifiedAt >= floor) written.push(filePath);
    }
    return written;
  }

  /** Which candidates git tracks and reports as untouched; empty when it cannot say. */
  private async unchangedInGit(cwd: string, candidates: readonly string[]): Promise<ReadonlySet<string>> {
    const unseen = candidates.filter((filePath) => !this.contents.has(filePath));
    if (this.git === undefined || unseen.length === 0) return new Set();
    return this.git.unchanged(cwd, unseen);
  }

  /** How many lines moved, when there is enough captured content to say. */
  private async countChanges(
    before: string | undefined,
    after: string | undefined,
    created: boolean,
  ): Promise<{ additions?: number; removals?: number }> {
    if (after === undefined) return {};
    if (before === undefined) {
      // A file that did not exist has an empty baseline, so every line it now
      // holds is an addition. A file that existed but went uncaptured has no
      // baseline to count against at all.
      if (!created) return {};
      const createdText = await this.snapshots.read(after);
      if (createdText === undefined) return {};
      const fresh = lineDiffFromEmpty(createdText);
      return { additions: fresh.additions, removals: fresh.removals };
    }
    if (before === after) return { additions: 0, removals: 0 };
    const [beforeText, afterText] = await Promise.all([this.snapshots.read(before), this.snapshots.read(after)]);
    if (beforeText === undefined || afterText === undefined) return {};
    const diff = lineDiff(beforeText, afterText);
    return { additions: diff.additions, removals: diff.removals };
  }

  /** Records the change unless it turned out to be no change at all. */
  private async append(event: TimelineEvent): Promise<void> {
    if (event.before !== undefined && event.before === event.after) return;
    await this.timeline.append(event);
  }

  /**
   * Folds a path the tool layer just handled into the tracked manifest, so the
   * next bash comparison sees it as already accounted for.
   *
   * The fingerprint has to be the one a walk would read, not a stand-in, or the
   * next comparison reports the file again under bash and every tool edit is
   * recorded twice.
   */
  private async remember(filePath: string): Promise<void> {
    if (this.manifest === undefined) return;
    const entries = new Map(this.manifest.entries);
    const fingerprint = await this.manifests.fingerprint(filePath);
    if (fingerprint === undefined) entries.delete(filePath);
    else entries.set(filePath, fingerprint);
    this.manifest = { entries, truncated: this.manifest.truncated };
  }
}

/** The tools this tracker knows how to attribute a change to. */
export const TRACKED_TOOLS: readonly FileEditTool[] = [EDIT_TOOL, WRITE_TOOL, BASH_TOOL];
