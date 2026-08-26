import type {
  WorkflowCatalogArtifactView,
  WorkflowCatalogEntryView,
  WorkflowCatalogInputView,
  WorkflowCatalogJobView,
} from '../types/webWorkflows.ts';

/**
 * The cockpit's view of the workflows a session can launch.
 *
 * The engine already reads a repository's workflow files and parses one of
 * them into triggers, inputs, jobs, artifacts and compatible runners, so this
 * module only shapes that answer for the wire and remembers what it read.
 *
 * WHY A CACHE:
 * A session's catalog is recomputed on a slow tick and again on every
 * subscribe, and parsing every workflow file each time is wasted work on files
 * that change a few times a week. Entries are kept per path and reused while
 * the file's size and modification time are unchanged, which is the same test
 * a build tool makes and costs one stat per file.
 */

/** What the engine reports for one workflow file before it is parsed. */
export interface CatalogListEntry {
  path: string;
  relativePath: string;
  name: string;
  description: string;
  tags: string[];
}

/** One file's parsed detail, or the reason it could not be read. */
export interface CatalogDetail {
  triggers: string[];
  inputs: WorkflowCatalogInputView[];
  jobs: WorkflowCatalogJobView[];
  artifacts: WorkflowCatalogArtifactView[];
  runners?: string[];
  error?: string;
}

/** What a file looked like when it was last parsed. */
export interface CatalogFileStamp {
  size: number;
  modifiedAt: number;
}

export interface WorkflowCatalogReaderDeps {
  /** Every workflow file under a directory. */
  list(directory: string): Promise<CatalogListEntry[]>;
  /** One file's parsed detail; never throws, so a bad file cannot empty a board. */
  summarize(path: string): CatalogDetail;
  /** Size and modification time, or undefined when the file is gone. */
  stamp(path: string): CatalogFileStamp | undefined;
}

interface CachedEntry {
  stamp: CatalogFileStamp;
  detail: CatalogDetail;
}

/** Reads one directory's catalog, reusing what it parsed last time. */
export interface WorkflowCatalogReader {
  read(directory: string): Promise<WorkflowCatalogEntryView[]>;
  /** Drops what was parsed for files no longer listed, so a cache cannot grow forever. */
  forget(keep: ReadonlySet<string>): void;
}

function unchanged(left: CatalogFileStamp | undefined, right: CatalogFileStamp | undefined): boolean {
  return left !== undefined && right !== undefined && left.size === right.size && left.modifiedAt === right.modifiedAt;
}

export function createWorkflowCatalogReader(deps: WorkflowCatalogReaderDeps): WorkflowCatalogReader {
  const cache = new Map<string, CachedEntry>();

  const detailFor = (path: string): CatalogDetail => {
    const stamp = deps.stamp(path);
    const cached = cache.get(path);
    if (cached && unchanged(cached.stamp, stamp)) return cached.detail;
    const detail = deps.summarize(path);
    // A file that vanished between listing and stat is parsed anyway, which
    // answers with its own error; it just cannot be cached against a stamp.
    if (stamp !== undefined) cache.set(path, { stamp, detail });
    return detail;
  };

  return {
    async read(directory) {
      const listed = await deps.list(directory);
      return listed.map((entry) => {
        const detail = detailFor(entry.path);
        return {
          path: entry.path,
          relativePath: entry.relativePath,
          name: entry.name === '' ? entry.relativePath : entry.name,
          description: entry.description,
          tags: entry.tags,
          triggers: detail.triggers,
          inputs: detail.inputs,
          jobs: detail.jobs,
          artifacts: detail.artifacts,
          ...(detail.runners === undefined ? {} : { runners: detail.runners }),
          ...(detail.error === undefined ? {} : { error: detail.error }),
        };
      });
    },
    forget(keep) {
      for (const path of cache.keys()) {
        if (!keep.has(path)) cache.delete(path);
      }
    },
  };
}

/** The launchable rows first, then the ones that would not parse, name ordered. */
export function presentWorkflowCatalog(entries: readonly WorkflowCatalogEntryView[]): WorkflowCatalogEntryView[] {
  return [...entries].sort((left, right) => {
    if ((left.error === undefined) !== (right.error === undefined)) return left.error === undefined ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}
