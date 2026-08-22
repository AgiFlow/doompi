/** Explicit, child-only Team runtime composition. */

import { NativeTeamChannelService } from '../intercom/nativeTeamChannel';
import { ControlChannelWatcher } from '../intercom/supervisorControlChannel';
import type { AsyncRunStatus } from '../runs/background/asyncExecution';
import { RunnerBootstrap } from '../runs/background/runnerBootstrap';
import { RunnerExecution } from '../runs/background/runnerExecution';
import { RunnerReporting } from '../runs/background/runnerReporting';
import { RunnerTeamMembership } from '../runs/background/runnerTeamMembership';
import { CoalescedStatusWriter } from '../runs/background/statusWriter';
import { TerminalPersistenceService } from '../runs/background/terminalPersistence';
import { PollScheduler } from '../pollScheduler';

/** Services used inside one spawned Pi child. Parent-only tool/TUI code is absent. */
export interface TeamPromptRuntime {
  readonly pollScheduler: PollScheduler;
  readonly statusWriter: CoalescedStatusWriter<AsyncRunStatus>;
  readonly terminalPersistence: TerminalPersistenceService<AsyncRunStatus>;
  readonly controlChannel: ControlChannelWatcher;
  readonly reporting: RunnerReporting;
  readonly teamMembership: RunnerTeamMembership;
  readonly bootstrap: RunnerBootstrap;
  readonly execution: RunnerExecution;
  readonly teamChannel: NativeTeamChannelService;
}

/** Build one fresh child graph without importing the parent extension surface. */
export function createTeamPromptRuntime(): TeamPromptRuntime {
  const pollScheduler = new PollScheduler();
  const statusWriter = new CoalescedStatusWriter<AsyncRunStatus>();
  const terminalPersistence = new TerminalPersistenceService(statusWriter);
  const controlChannel = new ControlChannelWatcher(pollScheduler);
  const reporting = new RunnerReporting(statusWriter);
  const teamMembership = new RunnerTeamMembership();
  const bootstrap = new RunnerBootstrap(statusWriter, terminalPersistence, reporting, teamMembership);
  const execution = new RunnerExecution(controlChannel, terminalPersistence, reporting, statusWriter);
  const teamChannel = new NativeTeamChannelService();

  return Object.freeze({
    pollScheduler,
    statusWriter,
    terminalPersistence,
    controlChannel,
    reporting,
    teamMembership,
    bootstrap,
    execution,
    teamChannel,
  });
}
