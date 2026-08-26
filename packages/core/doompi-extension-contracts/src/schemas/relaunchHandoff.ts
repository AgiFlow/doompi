import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';

/**
 * The relaunch handoff between a DoomPi runtime and its process supervisor.
 *
 * A launcher-class session cannot recompose its extension closure in place, so
 * a relaunch-class transition normally stays pending until a human reruns the
 * launcher with the new selection. A supervisor that owns the agent process
 * (doompi-server) opts into performing that relaunch itself: it points this
 * environment variable at a file path, the runtime writes the target selection
 * there and exits, and the supervisor respawns the agent with the recorded
 * major mode under the same session id.
 */
export const DOOM_RELAUNCH_FILE_ENV = 'DOOMPI_RELAUNCH_FILE';

const MAX_IDENTIFIER_LENGTH = 256;

export const RelaunchHandoffSchema = Type.Object(
  {
    version: Type.Literal(1),
    majorMode: Type.String({ minLength: 1, maxLength: MAX_IDENTIFIER_LENGTH }),
    operationId: Type.String({ minLength: 1, maxLength: MAX_IDENTIFIER_LENGTH }),
  },
  { additionalProperties: false },
);
export type RelaunchHandoff = Static<typeof RelaunchHandoffSchema>;

export function serializeRelaunchHandoff(handoff: RelaunchHandoff): string {
  return JSON.stringify(handoff);
}

/** The handoff a supervisor read back, or undefined for anything malformed. */
export function parseRelaunchHandoff(text: string): RelaunchHandoff | undefined {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    return undefined;
  }
  return Check(RelaunchHandoffSchema, candidate) ? candidate : undefined;
}
