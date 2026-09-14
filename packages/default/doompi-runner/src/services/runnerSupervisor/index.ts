import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** What a supervisor needs to run one command. */
export interface CommandSpec {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

/** Exit status the supervisor records once its command is gone. */
export interface ExitMetadata {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Sidecars a supervised run reads and writes beside its log. */
export interface SupervisorPaths {
  spec: string;
  gate: string;
  exit: string;
  logDone: string;
}

/**
 * Settings that make a terminal safe for a caller with no keyboard.
 *
 * Commands run inside an rmux pane, so their stdout is a real tty. Git and
 * friends take that as permission to open a pager, and `less` then waits at
 * `(END)` for a keypress nobody is there to send, so the run hangs until its
 * timeout. The same tty invites credential prompts, which hang the same way.
 * A conventional piped stdout disables both automatically; a pane has to be
 * told. A command that genuinely wants a pager can still ask for one, as in
 * `git -c core.pager=less log`.
 */
export const NO_TERMINAL_INPUT_ENV = {
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
};

const SPEC_MODE = 0o600;
const NOT_FOUND_ERROR_CODE = 'ENOENT';

export function supervisorPaths(directory: string, id: string): SupervisorPaths {
  return {
    spec: path.join(directory, `${id}.command.json`),
    gate: path.join(directory, `${id}.gate`),
    exit: path.join(directory, `${id}.exit.json`),
    logDone: path.join(directory, `${id}.log.done`),
  };
}

export function writeCommandSpec(target: string, spec: CommandSpec): void {
  fs.writeFileSync(target, `${JSON.stringify(spec)}\n`, { mode: SPEC_MODE });
}

export function readExitMetadata(target: string): ExitMetadata | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (typeof value !== 'object' || value === null) return undefined;
    const metadata = value as Partial<ExitMetadata>;
    const code = typeof metadata.code === 'number' ? metadata.code : null;
    const signal = typeof metadata.signal === 'string' ? (metadata.signal as NodeJS.Signals) : null;
    return { code, signal };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== NOT_FOUND_ERROR_CODE) {
      process.emitWarning(`Could not read runner exit metadata ${target}: ${String(error)}`);
    }
    return undefined;
  }
}

export function cleanupSupervisorFiles(paths: SupervisorPaths): void {
  for (const target of Object.values(paths)) {
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== NOT_FOUND_ERROR_CODE) process.emitWarning(String(error));
    }
  }
}

/**
 * Resolves an executable entry point by walking up to the `bin` directory that
 * ships beside this module. Source and published layouts nest services at
 * different depths. Source modules select built subprocess entries so Node can resolve their imports. A hardcoded depth stays silent
 * until the shell tries to exec it.
 */
export function runtimeEntry(name: 'runnerHost' | 'logSink', moduleUrl = import.meta.url): string {
  const modulePath = fileURLToPath(moduleUrl);
  const source = path.extname(modulePath) === '.ts';
  const extension = 'mjs';
  let directory = path.dirname(modulePath);

  while (true) {
    const entry = source
      ? path.join(directory, 'dist', 'bin', `${name}.${extension}`)
      : path.join(directory, 'bin', `${name}.${extension}`);
    if (fs.existsSync(entry)) return fs.realpathSync(entry);

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(`Cannot find bin/${name}.${extension} by walking up from ${modulePath}.`);
}

/**
 * Replaces the shell rather than nesting under it, so the pid handed back is the
 * supervisor's and a group signal reaches it directly.
 */
export function supervisorCommand(paths: SupervisorPaths): string {
  return `exec ${shellJoin([process.execPath, runtimeEntry('runnerHost'), paths.spec, paths.gate, paths.exit])}`;
}

export function shellJoin(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", `'"'"'`)}'`).join(' ');
}

/** A pending appearance of one supervisor sidecar, watched rather than polled for. */
export interface FileWatch {
  /** Resolves true once the file exists, or false when the slice elapses. */
  appeared(withinMs: number): Promise<boolean>;
  close(): void;
}

interface DirectoryWatch {
  watcher: fs.FSWatcher | undefined;
  readonly waiters: Map<string, Set<() => void>>;
  references: number;
}

/**
 * One watcher per directory, shared by every waiter inside it.
 *
 * A session's runners share a runs directory, and `DOOMPI_LOG_DIR` makes every
 * session using it share one. A watcher per waited file would then put a watcher
 * per in-flight runner on the same directory, each woken by every other runner's
 * sidecar writes, so the watchers are pooled and reference counted instead.
 */
const directoryWatches = new Map<string, DirectoryWatch>();

function acquireDirectoryWatch(directory: string): DirectoryWatch {
  const existing = directoryWatches.get(directory);
  if (existing) {
    existing.references += 1;
    return existing;
  }
  const entry: DirectoryWatch = { watcher: undefined, waiters: new Map(), references: 1 };
  try {
    entry.watcher = fs.watch(directory, (_event, changed) => {
      // A rename can arrive without a name, and then the only safe reading is
      // that any waiter in this directory might be the one it belongs to.
      const named = changed === null ? undefined : String(changed);
      const targets = named === undefined ? [...entry.waiters.values()] : [entry.waiters.get(named)];
      for (const listeners of targets) {
        if (!listeners) continue;
        for (const listener of listeners) listener();
      }
    });
    // A watcher that cannot report is a watcher whose slices time out, which the
    // caller's own probe already covers.
    entry.watcher.on('error', () => undefined);
  } catch {
    entry.watcher = undefined;
  }
  directoryWatches.set(directory, entry);
  return entry;
}

function releaseDirectoryWatch(directory: string, entry: DirectoryWatch): void {
  entry.references -= 1;
  if (entry.references > 0) return;
  entry.watcher?.close();
  entry.watcher = undefined;
  entry.waiters.clear();
  directoryWatches.delete(directory);
}

/**
 * Reports a supervisor sidecar landing on disk without polling for it.
 *
 * The sidecars are written once and never rewritten, so the directory's own
 * create event answers the only question a waiter has. Polling for them costs a
 * full poll interval on every run that finishes inside one, and the runs that
 * finish fastest are the ones that pay that tax most often.
 *
 * The watch is best effort: a platform or a directory that cannot deliver events
 * leaves every slice to time out, which is exactly the poll the caller already
 * runs as its fallback.
 */
export function watchForFile(filePath: string): FileWatch {
  const directory = path.dirname(filePath);
  const name = path.basename(filePath);
  const entry = acquireDirectoryWatch(directory);
  let released = false;
  let found = false;
  let notify: (() => void) | undefined;

  const settle = (): void => {
    if (found || !fs.existsSync(filePath)) return;
    found = true;
    notify?.();
  };
  const listeners = entry.waiters.get(name) ?? new Set<() => void>();
  listeners.add(settle);
  entry.waiters.set(name, listeners);

  // The file can land between opening the watcher and the first wait, and that
  // create event has nobody listening for it yet.
  settle();

  return {
    async appeared(withinMs: number): Promise<boolean> {
      if (found) return true;
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          notify = undefined;
          // The watcher is an optimisation, not the answer. A create event that
          // was coalesced, reported under the temporary name of a rename, or
          // never delivered at all must not outlive the slice it belongs to, so
          // every slice ends by asking the filesystem itself.
          settle();
          resolve(found);
        }, withinMs);
        // Deliberately left holding the event loop. A run still being waited on
        // is work, and a process that exits during the gap between two probes
        // drops the result its caller is awaiting.
        notify = () => {
          clearTimeout(timer);
          notify = undefined;
          resolve(true);
        };
      });
    },
    close(): void {
      if (released) return;
      released = true;
      notify = undefined;
      listeners.delete(settle);
      if (listeners.size === 0) entry.waiters.delete(name);
      releaseDirectoryWatch(directory, entry);
    },
  };
}
