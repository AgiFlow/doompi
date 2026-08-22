/** Writes a shell-tab title to whatever terminal surface the host owns. */
export type WriteTitle = (title: string) => void;

/** The four things a title controller can be asked to do, and its method names. */
export type ShellTitleAction = 'dispose' | 'set' | 'start' | 'stop';

/** One instruction for a title controller, and the message shape its worker consumes. */
export interface ShellTitleCommand {
  action: ShellTitleAction;
  title: string;
}

/**
 * Drives the shell tab title across a run.
 *
 * `start` animates a spinner in front of the title until `stop` restores the
 * idle one; `set` writes a title without animating; `dispose` writes the final
 * title and releases whatever machinery the implementation owns. Every method
 * takes the writer so the controller never has to hold a session reference.
 */
export interface ShellTitleController {
  set(title: string, write: WriteTitle): void;
  start(title: string, write: WriteTitle): void;
  stop(title: string, write: WriteTitle): void;
  dispose(title: string, write: WriteTitle): void;
}

/** One OS-level desktop notification. */
export interface DesktopNotification {
  title: string;
  subtitle: string;
  body: string;
}
