import type { RunnerRecord } from '../../types/runnerRegistry';

/** The disk record's shape guard, shared by the registry and every reader of its files. */
export function isRunnerRecord(value: unknown): value is RunnerRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<RunnerRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.pid === 'number' &&
    typeof record.command === 'string' &&
    typeof record.cwd === 'string' &&
    typeof record.logPath === 'string' &&
    typeof record.sessionId === 'string' &&
    typeof record.startedAt === 'string' &&
    (record.state === 'running' || record.state === 'completed') &&
    typeof record.promoted === 'boolean' &&
    (record.backend === 'rmux' || record.backend === 'tmux' || record.backend === 'native')
  );
}

/** What the agent reads when a runner it sent to the background exits. Shared by the Pi and server hosts. */
export function formatRunnerFinished(record: RunnerRecord): string {
  const outcome = record.exit?.reason ?? record.state;
  const code = record.exit?.code === null || record.exit?.code === undefined ? '' : `, exit code ${record.exit.code}`;
  return [
    `Background runner ${record.name} exited: ${outcome}${code}.`,
    `Runner ID: ${record.id}`,
    `Log: ${record.logPath}`,
    `Inspect: doom-runner logs ${record.id}`,
  ].join('\n');
}
