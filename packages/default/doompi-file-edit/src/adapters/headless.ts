import fs from 'node:fs';
import path from 'node:path';
import type {
  DoomHeadlessActivity,
  DoomHeadlessCommand,
  DoomHeadlessExecutionContext,
  DoomHeadlessHook,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { SUBAGENT_CHILD_ENV } from '@agimon-ai/doompi-extension-contracts/child-process';
import type { FileEditDependencies } from '../types/index.ts';
import { createDoomIgnoreMatcher } from '../services/doomIgnore.ts';
import { sweepSessionState } from './node/sessionStateSweep.ts';

const DOOM_IGNORE_FILE = '.doomignore';
const FILES_STATUS_KEY = 'doom-file-edit-files';

interface FileEditRuntime {
  readonly container: FileEditDependencies;
  readonly context: DoomHeadlessExecutionContext;
  readonly timelinePath: string;
  readonly snapshotsPath: string;
}

export interface FileEditHeadlessContributions {
  readonly activity: DoomHeadlessActivity;
  readonly hooks: readonly DoomHeadlessHook[];
  readonly command: DoomHeadlessCommand;
}

export function createFileEditHeadlessContributions(container: FileEditDependencies): FileEditHeadlessContributions {
  let runtime: FileEditRuntime | undefined;
  const activity: DoomHeadlessActivity = {
    name: 'file-edits',
    start: async (context: DoomHeadlessExecutionContext) => {
      const sessionKey = container.paths.sessionKey(context.sessionId);
      const timelinePath = container.paths.timelinePath(context.cwd, sessionKey);
      const snapshotsPath = container.paths.snapshotsPath(context.cwd, sessionKey);
      container.timeline.initialize(timelinePath);
      container.snapshots.initialize(snapshotsPath);
      const ignored = readDoomIgnore(context.cwd);
      container.editTracker.reset({
        exclude: [timelinePath, `${timelinePath}.lock`, snapshotsPath],
        ...(ignored ? { isIgnored: ignored } : {}),
      });
      runtime = { container, context, timelinePath, snapshotsPath };
      const entries = await container.timeline.list();
      context.client.setStatus(
        FILES_STATUS_KEY,
        entries.length === 0 ? '' : `${entries.length} ${entries.length === 1 ? 'file' : 'files'}`,
      );
      void sweepSessionState({ directory: container.paths.stateDirectory(), keep: timelinePath }).catch(
        () => undefined,
      );
      return async () => {
        if (runtime?.container !== container) return;
        runtime = undefined;
        container.editTracker.reset();
        if (!process.env[SUBAGENT_CHILD_ENV]) {
          await container.timeline.clear();
          await container.snapshots.clear();
        }
        context.client.setStatus(FILES_STATUS_KEY, undefined);
      };
    },
  };

  const hooks: DoomHeadlessHook[] = [
    {
      event: 'tool_execution_start',
      handle: async (event: Readonly<Record<string, unknown>>, context: DoomHeadlessExecutionContext) => {
        const active = runtime;
        if (!active) return;
        const toolCallId = stringValue(event, 'toolCallId');
        const toolName = stringValue(event, 'toolName');
        if (!toolCallId || !toolName) return;
        await active.container.editTracker.start(toolCallId, toolName, event.args, context.cwd);
      },
    },
    {
      event: 'tool_execution_end',
      handle: async (event: Readonly<Record<string, unknown>>, context: DoomHeadlessExecutionContext) => {
        const active = runtime;
        if (!active) return;
        const toolCallId = stringValue(event, 'toolCallId');
        if (!toolCallId) return;
        await active.container.editTracker.end(toolCallId, event.isError === true, context.cwd);
        const entries = await active.container.timeline.list();
        context.client.setStatus(
          FILES_STATUS_KEY,
          entries.length === 0 ? '' : `${entries.length} ${entries.length === 1 ? 'file' : 'files'}`,
        );
      },
    },
  ];

  const command: DoomHeadlessCommand = {
    name: 'file-edits',
    description: 'Report files changed during this session.',
    execute: async (_args: string, context: DoomHeadlessExecutionContext) => {
      const active = runtime;
      if (!active) {
        await context.client.notify({ body: 'File edit tracking is not active.', level: 'warning' });
        return;
      }
      const entries = await active.container.timeline.list();
      await context.client.notify({
        body:
          entries.length === 0
            ? 'No files edited in this session.'
            : `${entries.length} file${entries.length === 1 ? '' : 's'} edited in this session.`,
        level: 'info',
      });
    },
  };

  return { activity, hooks, command };
}

function stringValue(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function readDoomIgnore(cwd: string): ((filePath: string) => boolean) | undefined {
  let content: string;
  try {
    content = fs.readFileSync(path.join(cwd, DOOM_IGNORE_FILE), 'utf8');
  } catch {
    return undefined;
  }
  const matcher = createDoomIgnoreMatcher(content);
  return matcher ? (filePath: string) => matcher(path.relative(cwd, filePath)) : undefined;
}
