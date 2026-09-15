import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { resolveTrackedRunId, type TrackedAsyncJob } from '../../../../../services/asyncJobTracker';
import type { TeamPiScope } from '../root.cli';
import {
  notifyError,
  notifyInfo,
  sendSlashText,
  sessionScopeFor,
  type SlashCommandDeps,
  type SlashCommandState,
} from './_lib/launch';
import { readyCommand } from './_lib/ready';

export default (context: WithRoot<PiPluginContext, TeamPiScope>) =>
  readyCommand(context.root, createStopCommand(context.pi, context.root.state, context.root.slashCommandDeps));

export function createStopCommand(
  pi: ExtensionAPI,
  _state: SlashCommandState,
  deps: SlashCommandDeps,
): readonly [string, Parameters<ExtensionAPI['registerCommand']>[1]] {
  return [
    'subagents-stop',
    {
      description: 'Stop a running subagent: /subagents-stop [run-id]',
      handler: async (args, ctx) => {
        const scope = sessionScopeFor(ctx, deps.environment);
        deps.management.bindSessionScope(scope);
        const jobs = deps.tracker.forSession(ctx.sessionManager.getSessionId(), scope);
        const id = args.trim();
        if (!id) {
          sendSlashText(pi, stoppableRunsReport(jobs.list()));
          return;
        }
        try {
          await deps.management.stop(resolveTrackedRunId(jobs, id));
          // The direct control request is acknowledged by transport delivery. The
          // run's own event stream remains authoritative for its terminal state.
          notifyInfo(ctx, `Stop requested for ${id}. The run reports its own final state once it acknowledges.`);
        } catch (error) {
          // `ManagementActions.stop` throws only for an id that resolves to no
          // run or to more than one. Both are bad user input, not internal
          // faults, so they are notified rather than rethrown at the host - the
          // same treatment `reportKnownErrorOrRethrow` gives a parse error.
          notifyError(ctx, error instanceof Error ? error.message : `Could not stop '${id}'.`);
        }
      },
    },
  ];
}

/**
 * The no-argument `/subagents-stop` listing.
 *
 * The predecessor opened a TUI selector overlay here. This reports the same
 * information as text instead, for one reason worth stating rather than
 * hiding: a selector is a second, independent renderer of run state, and this
 * package already has one in `/subagents-fleet` that shows more (live status,
 * transcripts, and the full set of runtime controls including stop). Building
 * a second, weaker one would mean two things to keep in step. Passing an
 * explicit id stays the direct path, and the fleet overlay is the interactive
 * one.
 */
export function stoppableRunsReport(runs: readonly TrackedAsyncJob[]): string {
  const stoppable = runs.filter((run) => run.status === 'running' || run.status === 'pending');
  if (stoppable.length === 0) return 'No running subagents to stop.';
  const lines = stoppable.map((run) => `- ${run.runId}${run.status ? ` (${run.status})` : ''}`);
  return [
    'Running subagents:',
    ...lines,
    '',
    'Stop one with `/subagents-stop <run-id>`, or open `/subagents-fleet` to inspect and control them interactively.',
  ].join('\n');
}
