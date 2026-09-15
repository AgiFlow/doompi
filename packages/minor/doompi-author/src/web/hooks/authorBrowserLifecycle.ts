import type { WebPluginRuntime } from '@agimon-ai/doompi-core/web';

import { startAuthorBrowserBridge } from '../api/authorBrowserBridge';
import { recordAuthorCaptureStatus, recordAuthorComposerSubmission } from '../stores/authorRequestLifecycle';

export function startAuthorBrowserLifecycle(runtime: WebPluginRuntime): () => void {
  const stopBridge = startAuthorBrowserBridge(runtime);
  const stopSubmissions = runtime.onComposerSubmitted?.(recordAuthorComposerSubmission) ?? (() => undefined);
  const stopCaptureStatus = runtime.onCaptureStatus?.(recordAuthorCaptureStatus) ?? (() => undefined);
  return () => {
    stopSubmissions();
    stopCaptureStatus();
    stopBridge();
  };
}
