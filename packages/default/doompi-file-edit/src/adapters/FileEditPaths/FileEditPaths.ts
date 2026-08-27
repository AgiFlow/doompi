import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUBAGENT_CHILD_ENV, SUBAGENT_PARENT_SESSION_ENV } from '@agimon-ai/doompi-extension-contracts/child-process';
import type { IFileEditPaths } from '../../types/fileEditPaths';

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

  timelinePath(cwd: string, sessionKey: string): string {
    const commonDirectory = this.gitCommonDirectory(cwd);
    const worktree = hash(fs.realpathSync(cwd));
    const agentDirectory = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
    const directory = path.join(commonDirectory ?? agentDirectory, 'doom-file-edit');
    fs.mkdirSync(directory, { recursive: true });
    return path.join(directory, `${worktree}-${hash(sessionKey)}.jsonl`);
  }

  /**
   * Where this session's content snapshots live: beside its timeline and named
   * after it, so the two are found together and cleared together.
   */
  snapshotsPath(cwd: string, sessionKey: string): string {
    return `${this.timelinePath(cwd, sessionKey).replace(/\.jsonl$/u, '')}.blobs`;
  }

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
