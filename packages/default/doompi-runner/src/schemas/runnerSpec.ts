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
 * ships beside this module. Source and published layouts nest `schemas` at
 * different depths, and a hardcoded depth resolves to a path that stays silent
 * until the shell tries to exec it.
 */
export function runtimeEntry(name: 'runnerHost' | 'logSink', moduleUrl = import.meta.url): string {
  const modulePath = fileURLToPath(moduleUrl);
  const extension = path.extname(modulePath) === '.ts' ? 'ts' : 'mjs';
  let directory = path.dirname(modulePath);

  while (true) {
    const entry = path.join(directory, 'bin', `${name}.${extension}`);
    if (fs.existsSync(entry)) return entry;

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
