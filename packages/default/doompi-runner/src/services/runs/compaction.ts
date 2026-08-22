import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { RunnerRecord } from '../../types/runnerRegistry';

const COMPACTION_RUNNERS_MARKER = 'Active background runners survived compaction:';
const RUNNER_COMPACTION_MESSAGE = 'doom-runner-compaction';

export interface RunnerCompactionDependencies {
  getSessionId(): string | undefined | Promise<string | undefined>;
  listBySession(sessionId: string): Promise<RunnerRecord[]>;
}

export function activeRunnerRecovery(active: readonly RunnerRecord[]): string {
  if (active.length === 0) return '';
  const runners = active.flatMap((record) => [
    `- ${record.name} (${record.id}), log: ${record.logPath}`,
    `  Check: doom-runner status ${record.id}`,
    `  Stream: doom-runner logs ${record.id} --follow`,
  ]);
  return [
    COMPACTION_RUNNERS_MARKER,
    ...runners,
    'Use these CLI commands to inspect existing runners before launching another command.',
  ].join('\n');
}

export function appendActiveRunnersToSummary(summary: string, active: readonly RunnerRecord[]): string {
  if (active.length === 0 || summary.includes(COMPACTION_RUNNERS_MARKER)) return summary;
  return [summary, '', activeRunnerRecovery(active)].join('\n');
}

export function registerRunnerCompactionRecovery(pi: ExtensionAPI, dependencies: RunnerCompactionDependencies): void {
  pi.on('session_compact', async () => {
    const sessionId = await dependencies.getSessionId();
    if (!sessionId) return;
    let active: RunnerRecord[];
    try {
      active = await dependencies.listBySession(sessionId);
    } catch {
      // Recovery is advisory. Omit stale runner hints rather than failing a completed compaction.
      return;
    }
    const content = activeRunnerRecovery(active);
    if (!content) return;
    pi.sendMessage(
      {
        customType: RUNNER_COMPACTION_MESSAGE,
        content,
        display: false,
        details: { sessionId, runnerIds: active.map((record) => record.id) },
      },
      { triggerTurn: false, deliverAs: 'steer' },
    );
  });
}
