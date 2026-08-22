import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { sendSystemNotification } from '../../src/adapters/systemNotification.ts';

const COMMAND_TIMEOUT_MS = 3_000;

function execResult(code = 0) {
  return { stdout: '', stderr: '', code, killed: false };
}

function piWith(exec: ReturnType<typeof vi.fn>): ExtensionAPI {
  return { exec } as unknown as ExtensionAPI;
}

describe('sendSystemNotification', () => {
  it('uses cmux when it is available', async () => {
    const exec = vi.fn().mockResolvedValue(execResult());

    await sendSystemNotification(piWith(exec), { title: 'Pi', subtitle: 'Done', body: 'Finished' }, 'darwin');

    expect(exec).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith('cmux', ['notify', '--title', 'Pi', '--subtitle', 'Done', '--body', 'Finished'], {
      timeout: COMMAND_TIMEOUT_MS,
    });
  });

  it('falls back to macOS notifications when cmux reports failure', async () => {
    const exec = vi.fn().mockResolvedValueOnce(execResult(1)).mockResolvedValueOnce(execResult());

    await sendSystemNotification(piWith(exec), { title: 'Pi', subtitle: 'Waiting', body: 'Approve?' }, 'darwin');

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1]?.[0]).toBe('osascript');
    expect(exec.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining([
        'display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)',
        'Pi',
        'Waiting',
        'Approve?',
      ]),
    );
  });

  it('falls back when cmux is not installed at all', async () => {
    const exec = vi.fn().mockRejectedValueOnce(new Error('spawn cmux ENOENT')).mockResolvedValueOnce(execResult());

    await sendSystemNotification(piWith(exec), { title: 'Pi', subtitle: 'Waiting', body: 'Approve?' }, 'darwin');

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1]?.[0]).toBe('osascript');
  });

  it('stays silent on a host with no second notifier', async () => {
    const exec = vi.fn().mockResolvedValue(execResult(1));

    await sendSystemNotification(piWith(exec), { title: 'Pi', subtitle: 'Done', body: 'Finished' }, 'linux');

    expect(exec).toHaveBeenCalledOnce();
  });

  it('defaults to the platform it is running on', async () => {
    const exec = vi.fn().mockResolvedValue(execResult());

    await sendSystemNotification(piWith(exec), { title: 'Pi', subtitle: 'Done', body: 'Finished' });

    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0]?.[0]).toBe('cmux');
  });

  it('collapses and truncates the body before handing it to a notifier', async () => {
    const exec = vi.fn().mockResolvedValue(execResult());

    await sendSystemNotification(piWith(exec), { title: 'Pi', subtitle: 'Done', body: 'Two\n\nlines' }, 'darwin');

    expect(exec.mock.calls[0]?.[1]).toContain('Two lines');
  });
});
