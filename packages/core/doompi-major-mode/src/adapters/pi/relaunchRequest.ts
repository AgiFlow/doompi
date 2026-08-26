import fs from 'node:fs';
import {
  DOOM_RELAUNCH_FILE_ENV,
  serializeRelaunchHandoff,
} from '@agimon-ai/doompi-extension-contracts/relaunch-handoff';

/** Whether a process supervisor is listening for relaunch requests. */
export function supervisedRelaunchAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[DOOM_RELAUNCH_FILE_ENV]);
}

/**
 * Hands a relaunch-class major-mode switch to the process supervisor.
 *
 * A supervisor that owns this agent process (doompi-server) points
 * DOOMPI_RELAUNCH_FILE at a path it watches; writing the target selection
 * there asks it to end this agent's input for a graceful exit and respawn it
 * with the new major mode under the same session id. Write only when the
 * session is idle: the supervisor acts on the file as soon as it appears.
 * Returns false when no supervisor is listening or the write fails, in which
 * case the caller keeps the manual-relaunch message.
 */
export function requestSupervisedRelaunch(
  majorMode: string,
  operationId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const file = env[DOOM_RELAUNCH_FILE_ENV];
  if (!file) return false;
  try {
    fs.writeFileSync(file, serializeRelaunchHandoff({ version: 1, majorMode, operationId }));
    return true;
  } catch {
    return false;
  }
}
