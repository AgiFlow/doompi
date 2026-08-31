/** One repository's published API directory, or nothing when it was never synced. */
export type RegisteredApiDirectory = (from: string) => string | undefined;

export interface SessionApiDirectoryInput {
  /** The session's working directory; its repository is asked first. */
  readonly cwd: string;
  /** A directory inside the installation running the server, used as the fallback. */
  readonly installationDir: string;
  /** Resolves the synced API directory of the repository containing a path. */
  readonly registeredApiDirectory: RegisteredApiDirectory;
}

/**
 * Resolve the package API directory a session mounts
 *
 * A synced repository serves its own generation, so a checkout runs the
 * packages it declares rather than whatever the machine happens to hold. A
 * repository that has never been synced used to mount nothing at all, which
 * quietly cost those sessions every package API the cockpit itself depends on
 * (the plan panel among them) and surfaced only as a 404 in the browser. It
 * now inherits the installation that launched it: the generation running the
 * server is the closest thing an unsynced checkout has to an owner, and
 * inheriting it never overrides a repository that made its own choice.
 */
export function resolveSessionApiDirectory(input: SessionApiDirectoryInput): string | undefined {
  return input.registeredApiDirectory(input.cwd) ?? input.registeredApiDirectory(input.installationDir);
}
