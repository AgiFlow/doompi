import fs from 'node:fs';
import path from 'node:path';
import {
  readDoomHeadlessHost,
  type DoomHeadlessExecutionContext,
} from '@agimon-ai/doompi-extension-contracts/headless';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  requireDoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { createDoomIgnoreMatcher } from '../../services/doomIgnore.ts';
import { filesChannelType } from '../../types/webFiles.ts';
import { EditTracker } from '../EditTracker/EditTracker.ts';
import { FileEditPaths } from '../FileEditPaths/FileEditPaths.ts';
import { NodeGitStatusAdapter } from '../node/gitStatus.ts';
import { NodeSnapshotStoreAdapter } from '../node/snapshotStore.ts';
import { NodeTreeManifestAdapter } from '../node/treeManifest.ts';
import { TimelineStore } from '../TimelineStore/TimelineStore.ts';
import { api } from '../fileEditsApi.ts';
import { createFilesChannel, readSessionFiles } from '../webFilesChannel.ts';

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

/**
 * The file-edit server facet owns the package API in session servers, the live
 * file channel in the hub server, and headless edit tracking in session APIs.
 */
export const fileEditsServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomServerHost(context);
    const registrations = [] as Array<{ dispose(): void }>;
    if (host.scope === 'global' || host.scope === 'workspace')
      registrations.push(host.registerChannel(createFilesChannel()));
    if (host.scope !== 'session') {
      if (registrations.length === 0) return undefined;
      return () => {
        for (const registration of registrations.reverse()) registration.dispose();
      };
    }
    registrations.push(host.registerApi(api));

    const headless = readDoomHeadlessHost(context);
    if (headless === undefined) {
      return () => {
        for (const registration of registrations.reverse()) registration.dispose();
      };
    }
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
    const activity = headless.registerActivity({
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
    });
    const startHook = headless.registerHook({
      event: 'tool_execution_start',
      handle: async (event, executionContext) => {
        const runtime = active;
        const toolCallId = stringValue(event, 'toolCallId');
        const toolName = stringValue(event, 'toolName');
        if (
          runtime === undefined ||
          runtime.context.sessionId !== executionContext.sessionId ||
          !toolCallId ||
          !toolName
        )
          return;
        await editTracker.start(toolCallId, toolName, event.args, executionContext.cwd);
      },
    });
    const endHook = headless.registerHook({
      event: 'tool_execution_end',
      handle: async (event, executionContext) => {
        const runtime = active;
        const toolCallId = stringValue(event, 'toolCallId');
        if (runtime === undefined || runtime.context.sessionId !== executionContext.sessionId || !toolCallId) return;
        await editTracker.end(toolCallId, event.isError === true, executionContext.cwd);
        if (active === runtime) publish(runtime);
      },
    });
    registrations.push(activity, startHook, endHook);
    return () => {
      for (const registration of registrations.reverse()) registration.dispose();
    };
  },
};

export default fileEditsServerFacet;
