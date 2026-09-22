import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DoomHeadlessExecutionContext } from '@agimon-ai/doompi-core/headless';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFileEditSession } from '../../../src/services/fileEditSession';
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

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-file-edit-status-'));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
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
});
