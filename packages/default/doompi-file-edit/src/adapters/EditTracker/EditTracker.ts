import path from 'node:path';
import { lineDiff } from '../../services/lineDiff.ts';
import type { FileEditTool, TimelineEvent } from '../../types/domain';
import type { IEditTracker } from '../../types/editTracker';
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
 */
interface PendingEdit {
  tool: 'edit' | 'write';
  filePath: string;
  before: string | undefined;
}

function objectValue(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found : undefined;
}

export interface EditTrackerOptions {
  /** Injectable so a test can pin the recorded timestamps. */
  now?: () => number;
}

export class EditTracker implements IEditTracker {
  private readonly pending = new Map<string, PendingEdit>();
  /** Set while a bash call is in flight, so its end knows a manifest is owed. */
  private readonly bracketed = new Set<string>();
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
  private readonly now: () => number;

  constructor(
    private readonly timeline: ITimelineStore,
    private readonly snapshots: SnapshotStorePort,
    private readonly manifests: TreeManifestPort,
    options: EditTrackerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Forgets the previous session's tree so a new one does not inherit its
   * baseline, and takes the paths this session's own bookkeeping occupies.
   */
  reset(options: { exclude?: readonly string[] } = {}): void {
    this.pending.clear();
    this.bracketed.clear();
    this.manifest = undefined;
    this.excluded = options.exclude ?? [];
  }

  async start(id: string, tool: string, args: unknown, cwd: string): Promise<void> {
    if (tool === EDIT_TOOL || tool === WRITE_TOOL) {
      const supplied = objectValue(args, 'path');
      if (!supplied) return;
      const filePath = path.resolve(cwd, supplied);
      this.pending.set(id, { tool, filePath, before: await this.snapshots.capture(filePath) });
      return;
    }
    if (tool !== BASH_TOOL) return;
    this.bracketed.add(id);
    // The first bash call of a session has nothing to compare against, so it
    // pays for the baseline walk; every later call reuses the previous end.
    this.manifest ??= await this.manifests.take(cwd, this.excluded);
  }

  async end(id: string, isError: boolean, cwd: string): Promise<void> {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    const bracketed = this.bracketed.delete(id);
    if (isError) return;
    if (pending) {
      await this.recordTool(pending);
      return;
    }
    if (bracketed) await this.recordScan(cwd);
  }

  /** An `edit` or `write` whose file was read on both sides of the call. */
  private async recordTool(pending: PendingEdit): Promise<void> {
    const after = await this.snapshots.capture(pending.filePath);
    const counts = await this.countChanges(pending.before, after);
    await this.append({
      version: 2,
      path: pending.filePath,
      tool: pending.tool,
      at: this.now(),
      origin: 'tool',
      ...(pending.before === undefined ? {} : { before: pending.before }),
      ...(after === undefined ? {} : { after }),
      ...counts,
    });
    // The tool already accounted for this path, so the next bash comparison
    // must not report it a second time under its own name.
    await this.remember(pending.filePath);
  }

  /** Whatever moved while a bash call ran, however the command wrote it. */
  private async recordScan(cwd: string): Promise<void> {
    const before = this.manifest;
    if (before === undefined) return;
    const after = await this.manifests.take(cwd, this.excluded);
    this.manifest = after;
    for (const filePath of this.manifests.changed(before, after)) {
      await this.append({
        version: 2,
        path: filePath,
        tool: BASH_TOOL,
        at: this.now(),
        origin: 'scan',
        ...(await this.captured(filePath)),
      });
    }
  }

  /** The after-snapshot of a scan-found path, when it still exists and fits. */
  private async captured(filePath: string): Promise<{ after?: string }> {
    const after = await this.snapshots.capture(filePath);
    return after === undefined ? {} : { after };
  }

  /** How many lines moved, when both sides were captured. */
  private async countChanges(
    before: string | undefined,
    after: string | undefined,
  ): Promise<{ additions?: number; removals?: number }> {
    if (before === undefined || after === undefined) return {};
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
