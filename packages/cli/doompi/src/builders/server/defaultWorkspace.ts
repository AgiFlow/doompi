import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config/config';

const WORKSPACES_FOLDER = 'workspace';
const DIRECTORY_MODE = 0o700;
const GIT_TIMEOUT_MS = 15_000;

const run = promisify(execFile);

/**
 * Creates `~/.pi/.doom/workspace/<name>` for a workspace added by name alone.
 *
 * The folder is made a git repository because workspace admission resolves a
 * path to its nearest repository root; an empty folder would otherwise resolve
 * to `~/.pi`, whose `.doom` directory marks it as a root.
 */
export async function createDefaultWorkspaceFolder(name: string, homeDirectory: string): Promise<string> {
  if (name === '' || path.basename(name) !== name || name === '.' || name === '..')
    throw new Error(`"${name}" cannot be used as a workspace folder name.`);
  const folder = path.join(globalDoomConfigDirectory(homeDirectory), WORKSPACES_FOLDER, name);
  await fs.promises.mkdir(folder, { recursive: true, mode: DIRECTORY_MODE });
  if (!fs.existsSync(path.join(folder, '.git'))) {
    await run('git', ['init', '--quiet'], { cwd: folder, timeout: GIT_TIMEOUT_MS, windowsHide: true });
  }
  return folder;
}
