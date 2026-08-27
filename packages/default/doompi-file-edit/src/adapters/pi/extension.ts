import { SUBAGENT_CHILD_ENV } from '@agimon-ai/doompi-extension-contracts/child-process';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type { LeaderContribution } from '@agimon-ai/doompi-extension-contracts/leader';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { createDoomTelemetry, type DoomTelemetry } from '@agimon-ai/doompi-telemetry';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createFileEditContainer } from '../../container/index.ts';
import { filesStatusKey } from '../../types/webFiles.ts';

const FILES_COMMAND = 'file-edits';
const PACKAGE_SOURCE = '@agimon-ai/doompi-file-edit';

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

/** Install File Edit resources into its host-owned Cordis plugin fiber. */
export function installFileEditRuntime(cordis: Context, pi: ExtensionAPI): void {
  cordis.effect(function* () {
    const { paths, timeline, snapshots, editTracker: tracker, workflow } = createFileEditContainer();
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

    yield async () => {
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

    pi.registerCommand(FILES_COMMAND, {
      description: 'Review files edited in this session',
      handler: async (_args, ctx) => {
        if (!active) return;
        if (!ctx.hasUI) {
          ctx.ui.notify('/file-edits requires interactive mode', 'error');
          return;
        }
        await workflow.open(ctx);
      },
    });

    pi.on('session_start', (_event, ctx) => {
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
      tracker.reset({ exclude: [timelinePath, `${timelinePath}.lock`, snapshotsPath] });
      // A resumed session already has a timeline, so the group must show its
      // count from the first paint rather than waiting for the next edit.
      void publishStatus();
      void telemetry.recordEvent('doom_file_edit.timeline_started', { outcome: 'initialized' });
    });
    pi.on('tool_execution_start', async (event, ctx) => {
      if (!active) return;
      const ownGeneration = sessionGeneration;
      toolStartedAt.set(event.toolCallId, Date.now());
      await tracker.start(event.toolCallId, event.toolName, event.args, ctx.cwd);
      if (!active || ownGeneration !== sessionGeneration) {
        toolStartedAt.delete(event.toolCallId);
        return;
      }
      void telemetry.recordEvent('doom_file_edit.edit_started', { 'tool.name': event.toolName });
    });
    pi.on('tool_execution_end', async (event, ctx) => {
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
    });
  }, `${PACKAGE_SOURCE}/runtime`);
}

/** The package's single standard Pi factory. */
export async function fileEditExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(fileEditPlugin, { pi });
  try {
    await fiber;
  } catch (error) {
    try {
      await fiber.dispose();
    } finally {
      await connection.dispose();
    }
    throw error;
  }
  let disposal: Promise<void> | undefined;
  pi.on(
    'session_shutdown',
    () =>
      (disposal ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })()),
  );
}

interface FileEditPluginConfig {
  readonly pi: ExtensionAPI;
}

function fileEditPlugin(cordis: Context, config: FileEditPluginConfig): void {
  installFileEditRuntime(cordis, config.pi);
  cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
    const contribution = requireDoomUiHub(uiContext).registerLeader(FILE_EDIT_LEADER_CONTRIBUTION);
    return () => contribution.dispose();
  });
}
