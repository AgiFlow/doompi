import { defineWebPlugin, type WebPluginRuntime } from '@agimon-ai/doompi-web-contracts';
import { authorFileLinks } from './AuthorDocumentPanel.tsx';
import { AuthorPanel } from './AuthorPanel.tsx';
import { startAuthorBrowserBridge } from './authorBrowserBridge.ts';
import { authorChannel } from './authorStore.ts';
import { DescribeAuthorToolsToolCard } from './DescribeAuthorToolsToolCard.tsx';
import { OpenAuthoringFileToolCard } from './OpenAuthoringFileToolCard.tsx';
import { UseAuthorToolsToolCard } from './UseAuthorToolsToolCard.tsx';
import { recordAuthorComposerSubmission } from './authorRequestLifecycle.ts';
import { authorWorkspace } from './authorWorkspaceStore.ts';

/**
 * This package's cockpit presence: the named export the generated plugin
 * registry imports. Plugins are independent, so nothing here depends on
 * install order; every relation to another plugin resolves by name.
 */
function startAuthor(runtime: WebPluginRuntime): () => void {
  const stopBridge = startAuthorBrowserBridge(runtime);
  const stopSubmissions = runtime.onComposerSubmitted?.(recordAuthorComposerSubmission) ?? (() => undefined);
  return () => {
    stopSubmissions();
    stopBridge();
  };
}

export const webPlugin = defineWebPlugin({
  id: 'author',
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
});
