import { type Static, Type } from 'typebox';
import { Check, Errors } from 'typebox/value';

export const SUBAGENT_CHILD_ENV = 'PI_SUBAGENT_CHILD';
export const SUBAGENT_PARENT_SESSION_ENV = 'PI_SUBAGENT_PARENT_SESSION';
export const SUBAGENT_ROOT_SESSION_ENV = 'PI_SUBAGENT_ROOT_SESSION';
export const DOOM_CHILD_PROCESS_CONTEXT_ENV = 'DOOM_CHILD_PROCESS_CONTEXT_V1';
/** Marks a process whose caller already supplied its complete Doom extension set. */
export const DOOMPI_EXTENSIONS_PROVIDED_ENV = 'DOOMPI_EXTENSIONS_PROVIDED';
/** Marks a process that already composed its own extension set from the command line. */
export const DOOMPI_COMPOSED_ENV = 'DOOMPI_COMPOSED';

const COMPOSED_FLAG = '1';

/**
 * True when this process already applied the command line, so a reload does not.
 *
 * Extensions read this to tell a synchronized session from a launcher one, which
 * changes what they can promise the user about a pending selection.
 */
export function alreadyComposed(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[DOOMPI_COMPOSED_ENV] === COMPOSED_FLAG;
}

export function resolveRootSessionId(
  currentSessionId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const inherited = environment[SUBAGENT_ROOT_SESSION_ENV]?.trim();
  if (inherited) return inherited;
  const current = currentSessionId.trim();
  if (!current) throw new Error('A root session requires a non-empty current session id.');
  return current;
}

export const ChildProcessContextSchema = Type.Object(
  {
    parentSessionId: Type.String({ minLength: 1 }),
    workingDirectory: Type.String({ minLength: 1 }),
    mode: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type ChildProcessContext = Static<typeof ChildProcessContextSchema>;

export function encodeChildProcessContext(context: ChildProcessContext): string {
  return JSON.stringify(context);
}

export function decodeChildProcessContext(serialized: string): ChildProcessContext {
  const parsed: unknown = JSON.parse(serialized);
  if (!Check(ChildProcessContextSchema, parsed)) {
    const details = Errors(ChildProcessContextSchema, parsed)
      .map((error) => error.message)
      .join('; ');
    throw new Error(`Invalid child process context: ${details}`);
  }
  return parsed;
}

export function childProcessContextEnvironment(context: ChildProcessContext): Record<string, string> {
  return { [DOOM_CHILD_PROCESS_CONTEXT_ENV]: encodeChildProcessContext(context) };
}

export function readChildProcessContext(
  environment: Readonly<Record<string, string | undefined>>,
): ChildProcessContext | undefined {
  const serialized = environment[DOOM_CHILD_PROCESS_CONTEXT_ENV]?.trim();
  return serialized ? decodeChildProcessContext(serialized) : undefined;
}
