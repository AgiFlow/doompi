import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DoomHeadlessExecutionContext } from '@agimon-ai/doompi-core/headless';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileEditPaths } from '../../../src/services/fileEditPaths';
import { createFileEditSession } from '../../../src/services/fileEditSession';
import { NodeSnapshotStoreAdapter } from '../../../src/services/snapshotStore';
import { TimelineStore } from '../../../src/services/timelineStore';
import { filesStatusKey } from '../../../src/types/webFiles';

/**
 * The activity group's frame, not its rows.
 *
 * A cockpit drives this facet and never the Pi runtime, so the channel the
 * facet already published reached a dock that had no group to render it in.
 * These assertions are about the status that decides whether the group exists.
 */
describe('the file-edit server activity', () => {
  let cwd: string;
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-file-edit-status-'));
    cwd = path.join(root, 'repo');
    fs.mkdirSync(cwd);
    vi.stubEnv('PI_CODING_AGENT_DIR', path.join(root, 'agent'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function session() {
    const setStatus = vi.fn();
    const publish = vi.fn();
    const executionContext = {
      sessionId: 'file-edit-status-test',
      cwd,
      client: { notify: vi.fn(), request: vi.fn(), setStatus },
    } as unknown as DoomHeadlessExecutionContext;
    const plugin = createFileEditSession({
      agent: {},
      host: { context: { ...executionContext, directEvents: { publish } } },
    } as unknown as DoomServerPluginContext);
    return { plugin, executionContext, setStatus, publish };
  }

  it('publishes the status on start and clears it when the activity stops', async () => {
    const test = session();
    const activity = test.plugin.activities?.[0];
    if (!activity) throw new Error('The file-edit activity was not registered');

    const stop = await activity.start(test.executionContext);

    // Empty, not absent: the group declares hideWhenEmpty, so a session that has
    // edited nothing reports a key with no content and stays hidden.
    expect(test.setStatus).toHaveBeenCalledWith(filesStatusKey, '');
    expect(test.publish).toHaveBeenCalled();

    await stop();
    expect(test.setStatus).toHaveBeenLastCalledWith(filesStatusKey, undefined);
  });
  it('captures outside files around awaited calls and preserves successive versions', async () => {
    const test = session();
    const stop = await test.plugin.activities![0]!.start(test.executionContext);
    try {
      const start = test.plugin.hooks?.find((hook) => hook.event === 'tool_call');
      const end = test.plugin.hooks?.find((hook) => hook.event === 'tool_result');
      expect(start).toBeDefined();
      expect(end).toBeDefined();
      const filePath = path.join(root, 'outside.md');
      for (const [id, content, isError] of [
        ['first', 'one\n', false],
        ['second', 'two\n', false],
        ['noop', 'two\n', false],
        ['failed', 'ignored\n', true],
      ] as const) {
        await start!.handle(
          { toolCallId: id, toolName: 'write', args: { path: filePath, content } },
          test.executionContext,
        );
        if (!isError) fs.writeFileSync(filePath, content);
        await end!.handle({ toolCallId: id, toolName: 'write', isError }, test.executionContext);
      }
      const paths = new FileEditPaths();
      const timeline = new TimelineStore();
      timeline.initialize(paths.timelinePath(cwd, test.executionContext.sessionId));
      const snapshots = new NodeSnapshotStoreAdapter();
      snapshots.initialize(paths.snapshotsPath(cwd, test.executionContext.sessionId));
      const versions = await timeline.versions(filePath);
      expect(versions).toHaveLength(2);
      expect(versions[0]).toMatchObject({ origin: 'tool', tool: 'write', created: true });
      expect(await snapshots.read(versions[0]!.after!)).toBe('one\n');
      expect(await snapshots.read(versions[1]!.before!)).toBe('one\n');
      expect(await snapshots.read(versions[1]!.after!)).toBe('two\n');
      expect(test.publish).toHaveBeenLastCalledWith(expect.any(String), test.executionContext.sessionId, {
        items: [expect.objectContaining({ path: filePath, tool: 'write', count: 2 })],
      });
    } finally {
      await stop();
    }
  });
});
