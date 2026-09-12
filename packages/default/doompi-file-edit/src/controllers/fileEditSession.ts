import fs from 'node:fs';
import path from 'node:path';
import {
  type DoomHeadlessExecutionContext,
  type DoomHeadlessActivity,
  type DoomHeadlessHook,
} from '@agimon-ai/doompi-core/headless';
import type { DoomServerPluginContext, DoomServerSessionPlugin } from '@agimon-ai/doompi-core/server-facet';
import { createDoomIgnoreMatcher } from '../services/doomIgnore';
import { filesChannelType } from '../types/webFiles';
import { EditTracker } from '../services/editTracker';
import { FileEditPaths } from '../services/fileEditPaths';
import { NodeGitStatusAdapter } from '../services/gitStatus';
import { NodeSnapshotStoreAdapter } from '../services/snapshotStore';
import { NodeTreeManifestAdapter } from '../services/treeManifest';
import { TimelineStore } from '../services/timelineStore';
import { api } from './fileEditsApi';
import { readSessionFiles } from './webFilesChannel';

const DOOM_IGNORE_FILE = '.doomignore';

function readDoomIgnore(cwd: string): ((filePath: string) => boolean) | undefined {
  try {
    const matcher = createDoomIgnoreMatcher(fs.readFileSync(path.join(cwd, DOOM_IGNORE_FILE), 'utf8'));
    return matcher === undefined ? undefined : (filePath: string) => matcher(path.relative(cwd, filePath));
  } catch {
    return undefined;
  }
}

function stringValue(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

export function createFileEditSession({ agent, host }: DoomServerPluginContext): DoomServerSessionPlugin {
  if (!agent) return { api: [api] };
  const paths = new FileEditPaths();
  const timeline = new TimelineStore();
  const snapshots = new NodeSnapshotStoreAdapter();
  const editTracker = new EditTracker(timeline, snapshots, new NodeTreeManifestAdapter(), {
    git: new NodeGitStatusAdapter(),
  });
  if (host.context.directEvents === undefined)
    throw new Error('File-edit headless facet requires the session direct event bus.');
  const directEvents = host.context.directEvents;
  let active:
    | {
        readonly context: DoomHeadlessExecutionContext;
        readonly timelinePath: string;
        readonly snapshotsPath: string;
      }
    | undefined;
  const publish = (runtime: NonNullable<typeof active>): void => {
    directEvents.publish(filesChannelType, runtime.context.sessionId, {
      items: readSessionFiles(runtime.timelinePath, runtime.context.cwd),
    });
  };
  const activity: DoomHeadlessActivity = {
    name: 'file-edits',
    start: async (executionContext) => {
      const sessionKey = paths.sessionKey(executionContext.sessionId);
      const timelinePath = paths.timelinePath(executionContext.cwd, sessionKey);
      const snapshotsPath = paths.snapshotsPath(executionContext.cwd, sessionKey);
      timeline.initialize(timelinePath);
      snapshots.initialize(snapshotsPath);
      const isIgnored = readDoomIgnore(executionContext.cwd);
      editTracker.reset({
        exclude: [timelinePath, `${timelinePath}.lock`, snapshotsPath],
        ...(isIgnored === undefined ? {} : { isIgnored }),
      });
      const runtime = { context: executionContext, timelinePath, snapshotsPath };
      active = runtime;
      publish(runtime);
      return async () => {
        if (active !== runtime) return;
        active = undefined;
        editTracker.reset();
      };
    },
  };
  const startHook: DoomHeadlessHook = {
    event: 'tool_execution_start',
    handle: async (event, executionContext) => {
      const runtime = active;
      const toolCallId = stringValue(event, 'toolCallId');
      const toolName = stringValue(event, 'toolName');
      if (runtime === undefined || runtime.context.sessionId !== executionContext.sessionId || !toolCallId || !toolName)
        return;
      await editTracker.start(toolCallId, toolName, event.args, executionContext.cwd);
    },
  };
  const endHook: DoomHeadlessHook = {
    event: 'tool_execution_end',
    handle: async (event, executionContext) => {
      const runtime = active;
      const toolCallId = stringValue(event, 'toolCallId');
      if (runtime === undefined || runtime.context.sessionId !== executionContext.sessionId || !toolCallId) return;
      await editTracker.end(toolCallId, event.isError === true, executionContext.cwd);
      if (active === runtime) publish(runtime);
    },
  };
  return { api: [api], activities: [activity], hooks: [startHook, endHook] };
}
