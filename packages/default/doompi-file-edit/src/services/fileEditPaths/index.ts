import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SUBAGENT_CHILD_ENV, SUBAGENT_PARENT_SESSION_ENV } from '@agimon-ai/doompi-core/child-process';

import type { IFileEditPaths } from '../../types/fileEditPaths';

/** The directory this package owns, under whichever root holds agent state. */
const STATE_DIRECTORY = 'doom-file-edit';
const AGENT_DIRECTORY = ['.pi', 'agent'];

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export class FileEditPaths implements IFileEditPaths {
  sessionKey(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
    if (env[SUBAGENT_CHILD_ENV]) {
      const parent = env[SUBAGENT_PARENT_SESSION_ENV];
      if (parent) return parent;
    }
    return sessionId;
  }

  /**
   * Where every session's state lives: the Pi agent directory, the same root
   * every other Doom package writes to, and never inside the working tree.
   *
   * An earlier layout put this in the repository's git common directory. That
   * is git's own storage: nothing in git's lifecycle prunes a directory we add
   * to it, a linked worktree writes into the main checkout rather than its own,
   * a submodule writes inside `.git/modules`, and `PI_CODING_AGENT_DIR` was
   * ignored outright. The snapshots are verbatim copies of files the session
   * touched, so where they land is a question about handling content, not a
   * question about convenience.
   */
  stateDirectory(): string {
    const configured = process.env.PI_CODING_AGENT_DIR?.trim();
    const root =
      configured === undefined || configured === '' ? path.join(os.homedir(), ...AGENT_DIRECTORY) : configured;
    return path.join(root, STATE_DIRECTORY);
  }

  /**
   * One session's timeline, named from its working directory and its session so
   * the hub and the session API can find it from another process knowing only
   * those two things.
   */
  timelinePath(cwd: string, sessionKey: string): string {
    const directory = this.stateDirectory();
    fs.mkdirSync(directory, { recursive: true });
    return path.join(directory, `${hash(fs.realpathSync(cwd))}-${hash(sessionKey)}.jsonl`);
  }

  /**
   * Where this session's content snapshots live: beside its timeline and named
   * after it, so the two are found together and cleared together.
   */
  snapshotsPath(cwd: string, sessionKey: string): string {
    return `${this.timelinePath(cwd, sessionKey).replace(/\.jsonl$/u, '')}.blobs`;
  }

  legacyStateDirectory(cwd: string): string | undefined {
    const common = this.gitCommonDirectory(cwd);
    return common === undefined ? undefined : path.join(common, STATE_DIRECTORY);
  }

  /** Only still read so the state an older build left behind can be cleared away. */
  private gitCommonDirectory(cwd: string): string | undefined {
    try {
      const result = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return result || undefined;
    } catch (error) {
      if (error instanceof Error) return undefined;
      throw error;
    }
  }
}
