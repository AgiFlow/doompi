import fs from 'node:fs';
import path from 'node:path';
import { SUBAGENT_CHILD_ENV } from '@agimon-ai/doompi-extension-contracts/child-process';
import type { PiPluginContributions } from '@agimon-ai/doompi-extension-contracts/pi-extension';
import type { LeaderContribution } from '@agimon-ai/doompi-extension-contracts/leader';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { createDoomTelemetry, type DoomTelemetry } from '@agimon-ai/doompi-telemetry';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { FileEditDependencies } from '../types';
import { sweepSessionState } from '../services/sessionStateSweep';
import { createDoomIgnoreMatcher } from '../services/doomIgnore';
import { filesStatusKey } from '../types/webFiles';

import { FILES_COMMAND, PACKAGE_SOURCE, DOOM_IGNORE_FILE } from '../constants/package';
/**
 * The project's ignore rules as a test over absolute paths, or nothing when the
 * file is absent, empty, or unreadable.
 *
 * Read once per session, like the exclude list it is passed beside. The web
 * reader re-reads the same file per request, so a mid-session edit reaches the
 * list before it reaches the recorder; that is a pre-existing difference and
 * not one this read introduces.
 */
function readDoomIgnore(cwd: string): ((filePath: string) => boolean) | undefined {
  let content: string;
  try {
    content = fs.readFileSync(path.join(cwd, DOOM_IGNORE_FILE), 'utf8');
  } catch {
    return undefined;
  }
  const matcher = createDoomIgnoreMatcher(content);
  if (matcher === undefined) return undefined;
  return (filePath: string): boolean => matcher(path.relative(cwd, filePath));
}

export const FILE_EDIT_LEADER_CONTRIBUTION = {
  source: PACKAGE_SOURCE,
  bindings: [
    {
      id: 'editor.files',
      path: [
        { key: 'e', label: 'extension', detail: 'tools, skills and config', order: 50 },
        { key: 'f', label: 'files', detail: 'session edits' },
      ],
      command: { name: FILES_COMMAND },
    },
  ],
} as const satisfies LeaderContribution;
export function createFileEditRuntime(dependencies: FileEditDependencies): PiPluginContributions {
  const { paths, timeline, snapshots, editTracker: tracker, workflow } = dependencies;
  const telemetry: DoomTelemetry = createDoomTelemetry({
    serviceName: 'doom-file-edit',
    packageName: PACKAGE_SOURCE,
    env: process.env,
    enableLogs: true,
    enableTraces: true,
  });
  const toolStartedAt = new Map<string, number>();
  let active = true;
  let sessionGeneration = 0;
  let sessionContext: ExtensionContext | undefined;

  /**
   * Publishes the count the cockpit's activity group keys off. The group is
   * hidden until this status exists, so it is written on every append rather
   * than only when the count changes.
   */
  const publishStatus = async (): Promise<void> => {
    if (!active || !sessionContext?.hasUI) return;
    const entries = await timeline.list();
    sessionContext.ui.setStatus(
      filesStatusKey,
      entries.length === 0 ? '' : `${entries.length} ${entries.length === 1 ? 'file' : 'files'}`,
    );
  };

  const dispose = async () => {
    active = false;
    sessionGeneration += 1;
    toolStartedAt.clear();
    tracker.reset();
    const closing = sessionContext;
    sessionContext = undefined;
    try {
      if (!process.env[SUBAGENT_CHILD_ENV]) {
        await timeline.clear();
        // The snapshots exist only to diff this session, so they go with it
        // rather than accumulating a copy of the tree on every run.
        await snapshots.clear();
      }
      if (closing?.hasUI) closing.ui.setStatus(filesStatusKey, undefined);
      await telemetry.recordEvent('doom_file_edit.timeline_finished', { outcome: 'closed' });
    } finally {
      await telemetry.shutdown();
    }
  };

  /**
   * Clears state no session will claim again. Never awaited and never allowed
   * to throw: a sweep that cannot run is not a reason to fail a session.
   */
  const sweepAbandonedState = async (cwd: string, keep: string): Promise<void> => {
    try {
      await sweepSessionState({ directory: paths.stateDirectory(), keep });
      const legacy = paths.legacyStateDirectory(cwd);
      if (legacy === undefined || legacy === paths.stateDirectory()) return;
      // Same age rule, so a build still running against the old location is
      // not robbed of the session it is in the middle of.
      await sweepSessionState({ directory: legacy, removeDirectory: true });
    } catch {
      // Nothing here is worth interrupting a session that is starting.
    }
  };
  return {
    onDispose: dispose,
    services: [
      (cordis: Context) => {
        cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
          const contribution = requireDoomUiHub(uiContext).registerLeader(FILE_EDIT_LEADER_CONTRIBUTION);
          return () => contribution.dispose();
        });
      },
    ],
    commands: [
      [
        FILES_COMMAND,
        {
          description: 'Review files edited in this session',
          handler: async (_args, ctx) => {
            if (!active) return;
            if (!ctx.hasUI) {
              ctx.ui.notify('/file-edits requires interactive mode', 'error');
              return;
            }
            await workflow.open(ctx);
          },
        },
      ],
    ],
    events: {
      session_start: (_event, ctx) => {
        if (!active) return;
        sessionGeneration += 1;
        toolStartedAt.clear();
        sessionContext = ctx;
        const sessionKey = paths.sessionKey(ctx.sessionManager.getSessionId());
        const timelinePath = paths.timelinePath(ctx.cwd, sessionKey);
        const snapshotsPath = paths.snapshotsPath(ctx.cwd, sessionKey);
        timeline.initialize(timelinePath);
        snapshots.initialize(snapshotsPath);
        // Inside a git worktree these land under the repository's own git
        // directory, which can sit inside the tree the tracker walks. Naming them
        // here is what stops the package's bookkeeping reading as session edits.
        // Whatever earlier sessions were killed before they could clean up, plus
        // anything an older build left in the repository's own git directory.
        void sweepAbandonedState(ctx.cwd, timelinePath);
        const isIgnored = readDoomIgnore(ctx.cwd);
        tracker.reset({
          exclude: [timelinePath, `${timelinePath}.lock`, snapshotsPath],
          ...(isIgnored === undefined ? {} : { isIgnored }),
        });
        // A resumed session already has a timeline, so the group must show its
        // count from the first paint rather than waiting for the next edit.
        void publishStatus();
        void telemetry.recordEvent('doom_file_edit.timeline_started', { outcome: 'initialized' });
      },
      tool_execution_start: async (event, ctx) => {
        if (!active) return;
        const ownGeneration = sessionGeneration;
        toolStartedAt.set(event.toolCallId, Date.now());
        await tracker.start(event.toolCallId, event.toolName, event.args, ctx.cwd);
        if (!active || ownGeneration !== sessionGeneration) {
          toolStartedAt.delete(event.toolCallId);
          return;
        }
        void telemetry.recordEvent('doom_file_edit.edit_started', { 'tool.name': event.toolName });
      },
      tool_execution_end: async (event, ctx) => {
        if (!active) return;
        const startedAt = toolStartedAt.get(event.toolCallId);
        toolStartedAt.delete(event.toolCallId);
        await tracker.end(event.toolCallId, event.isError, ctx.cwd);
        if (!active) return;
        await publishStatus();
        void telemetry.recordEvent('doom_file_edit.edit_finished', {
          'tool.name': event.toolName,
          'tool.result.error': event.isError,
          ...(startedAt === undefined ? {} : { duration_ms: Date.now() - startedAt }),
          outcome: event.isError ? 'failed' : 'completed',
        });
      },
    },
  };
}
