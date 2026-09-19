import type { WebPluginRuntime } from '@agimon-ai/doompi-core/web';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  stopBridge: vi.fn(),
  stopPersistence: vi.fn<() => Promise<void>>(),
  stopSubmissions: vi.fn(),
  stopCaptureStatus: vi.fn(),
  recordSubmission: vi.fn(),
  recordCaptureStatus: vi.fn(),
}));

vi.mock('../../src/extensions/workspaces/sessions/(frontend)/_lib/authorAnnotationPersistence', () => ({
  startAuthorAnnotationPersistence: () => controls.stopPersistence,
}));
vi.mock('../../src/extensions/workspaces/sessions/(frontend)/_lib/authorBrowserBridge', () => ({
  startAuthorBrowserBridge: () => controls.stopBridge,
}));
vi.mock('../../src/extensions/workspaces/sessions/(frontend)/lifecycle/_lib/authorRequestLifecycle', () => ({
  recordAuthorComposerSubmission: controls.recordSubmission,
  recordAuthorCaptureStatus: controls.recordCaptureStatus,
}));

import { startAuthorBrowserLifecycle } from '../../src/extensions/workspaces/sessions/(frontend)/lifecycle/_lib/authorBrowserLifecycle';

describe('startAuthorBrowserLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.stopPersistence.mockResolvedValue();
  });

  it('subscribes and disposes every browser integration', async () => {
    const runtime = {
      onComposerSubmitted: vi.fn(() => controls.stopSubmissions),
      onCaptureStatus: vi.fn(() => controls.stopCaptureStatus),
    } as unknown as WebPluginRuntime;

    await startAuthorBrowserLifecycle(runtime)();

    expect(runtime.onComposerSubmitted).toHaveBeenCalledWith(controls.recordSubmission);
    expect(runtime.onCaptureStatus).toHaveBeenCalledWith(controls.recordCaptureStatus);
    expect(controls.stopSubmissions).toHaveBeenCalledOnce();
    expect(controls.stopCaptureStatus).toHaveBeenCalledOnce();
    expect(controls.stopBridge).toHaveBeenCalledOnce();
    expect(controls.stopPersistence).toHaveBeenCalledOnce();
  });

  it('supports optional host observers and contains persistence shutdown failures', async () => {
    controls.stopPersistence.mockRejectedValueOnce(new Error('storage closed'));

    await expect(startAuthorBrowserLifecycle({} as WebPluginRuntime)()).resolves.toBeUndefined();
    expect(controls.stopBridge).toHaveBeenCalledOnce();
  });
});
