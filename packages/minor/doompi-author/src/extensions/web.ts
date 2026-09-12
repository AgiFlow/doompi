import { defineWebPlugin, type WebPluginRuntime } from '@agimon-ai/doompi-core/web';
import { authorFileLinks } from '../web/components/AuthorDocumentPanel';
import { AuthorPanel } from '../web/components/AuthorPanel';
import { startAuthorBrowserBridge } from '../web/api/authorBrowserBridge';
import { authorChannel } from '../web/stores/authorStore';
import { DescribeAuthorToolsToolCard } from '../web/components/DescribeAuthorToolsToolCard';
import { OpenAuthoringFileToolCard } from '../web/components/OpenAuthoringFileToolCard';
import { UseAuthorToolsToolCard } from '../web/components/UseAuthorToolsToolCard';
import { recordAuthorCaptureStatus, recordAuthorComposerSubmission } from '../web/stores/authorRequestLifecycle';
import { authorWorkspace } from '../web/stores/authorWorkspaceStore';

/**
 * This package's cockpit presence: the named export the generated plugin
 * registry imports. Plugins are independent, so nothing here depends on
 * install order; every relation to another plugin resolves by name.
 */
function startAuthor(runtime: WebPluginRuntime): () => void {
  const stopBridge = startAuthorBrowserBridge(runtime);
  const stopSubmissions = runtime.onComposerSubmitted?.(recordAuthorComposerSubmission) ?? (() => undefined);
  const stopCaptureStatus = runtime.onCaptureStatus?.(recordAuthorCaptureStatus) ?? (() => undefined);
  return () => {
    stopSubmissions();
    stopCaptureStatus();
    stopBridge();
  };
}

export const webPlugin = defineWebPlugin({
  id: 'author',
  session: {
    dockFaces: [
      {
        id: 'authoring',
        label: 'authoring',
        order: 30,
        autoSelect: true,
        panel: AuthorPanel,
        requiredMinorMode: 'author',
        visibility: {
          subscribe(listener) {
            const subscription = authorWorkspace.store.subscribe(listener);
            return () => subscription.unsubscribe();
          },
          isVisible(sessionId) {
            return sessionId !== null && authorWorkspace.store.state.sessions[sessionId]?.focusedDocument !== undefined;
          },
        },
      },
    ],
    minorModes: [{ name: 'author', keys: 'o a', order: 45 }],
    leaderBindings: [
      {
        id: 'author.toggle',
        path: [
          { key: 'o', label: 'other', detail: 'optional modes and tools' },
          { key: 'a', label: 'author', detail: 'enable or disable focused document authoring' },
        ],
        command: 'minor author',
      },
    ],
    channels: [authorChannel],
    fileLinks: authorFileLinks,
    toolRenderers: [
      { tools: ['open_authoring_file'], message: OpenAuthoringFileToolCard },
      { tools: ['describe_author_tools'], message: DescribeAuthorToolsToolCard },
      { tools: ['use_author_tools'], message: UseAuthorToolsToolCard },
    ],
    start: startAuthor,
  },
});
