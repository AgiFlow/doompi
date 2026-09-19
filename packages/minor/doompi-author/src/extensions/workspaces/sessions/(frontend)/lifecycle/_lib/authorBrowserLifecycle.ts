import type { WebPluginRuntime } from '@agimon-ai/doompi-core/web';

import { startAuthorAnnotationPersistence } from '../../_lib/authorAnnotationPersistence';
import { startAuthorBrowserBridge } from '../../_lib/authorBrowserBridge';
import { recordAuthorCaptureStatus, recordAuthorComposerSubmission } from './authorRequestLifecycle';

export function startAuthorBrowserLifecycle(runtime: WebPluginRuntime): () => void {
  const stopBridge = startAuthorBrowserBridge(runtime);
  const stopPersistence = startAuthorAnnotationPersistence();
  const stopSubmissions = runtime.onComposerSubmitted?.(recordAuthorComposerSubmission) ?? (() => undefined);
  const stopCaptureStatus = runtime.onCaptureStatus?.(recordAuthorCaptureStatus) ?? (() => undefined);
  return () => {
    stopSubmissions();
    stopCaptureStatus();
    stopPersistence();
    stopBridge();
  };
}
