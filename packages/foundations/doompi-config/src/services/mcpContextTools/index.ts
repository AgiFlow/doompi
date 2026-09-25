import type { DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';

import { loadContextParameters, renameThreadParameters } from '../../schemas/mcpContextTools';
import { sessionViewSchema } from '../../schemas/mcpSessionView';
import type { SessionView } from '../../types/sessionView';

export function createLoadContextTool(context: DoomMcpPluginContext): DoomHeadlessTool<typeof loadContextParameters> {
  return {
    // web-plugin-tool-renderers: ignore load_context (remote MCP only)
    name: 'load_context',
    label: 'Load context',
    description:
      'Call at the beginning of a session, and after changing profile or modes, to load repository instructions and current session context.',
    parameters: loadContextParameters,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute() {
      const snapshot = context.loadContext();
      return { content: [{ type: 'text', text: JSON.stringify(snapshot) }], structuredContent: { ...snapshot } };
    },
  };
}

export function createRenameThreadTool(context: DoomMcpPluginContext): DoomHeadlessTool<typeof renameThreadParameters> {
  return {
    // web-plugin-tool-renderers: ignore rename_thread (remote MCP only)
    name: 'rename_thread',
    label: 'Rename thread',
    description: 'Rename the current Doompi conversation so its purpose is clear in the workspace session list.',
    parameters: renameThreadParameters,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_toolCallId, { title }) {
      const next = title.trim();
      if (!next) throw new Error('Thread title cannot be empty.');
      if (context.execution.session.setName === undefined) throw new Error('Session rename is unavailable.');
      await context.execution.session.setName(next);
      return { content: [{ type: 'text', text: `Renamed thread to "${next}".` }] };
    },
  };
}

export function createShowSessionTool(context: DoomMcpPluginContext): DoomHeadlessTool<typeof loadContextParameters> {
  return {
    // web-plugin-tool-renderers: ignore show_session (remote MCP only)
    name: 'show_session',
    label: 'Show session',
    description:
      'Show or refresh a read-only summary of the current Doompi session. Does not load repository instructions.',
    parameters: loadContextParameters,
    outputSchema: { ...sessionViewSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      ui: { visibility: ['model', 'app'] },
      'openai/toolInvocation/invoking': 'Loading session',
      'openai/toolInvocation/invoked': 'Session ready',
    },
    async execute() {
      const snapshot = context.loadContext();
      const view: SessionView = {
        sessionId: snapshot.session.id,
        revision: snapshot.session.revision,
        repositoryName:
          snapshot.repository.root.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? 'Repository',
        profile: snapshot.selection.profile,
        majorMode: snapshot.selection.majorMode,
        domains: [...snapshot.selection.domains],
        layers: [...snapshot.selection.activeLayers],
        minorModes: [...(snapshot.selection.minorModes ?? [])],
      };
      const text = [
        `Doompi session: ${view.sessionId} (revision ${view.revision})`,
        `Repository: ${view.repositoryName}`,
        `Profile: ${view.profile ?? 'Default'}`,
        `Major mode: ${view.majorMode}`,
        `Domains: ${view.domains.join(', ') || 'None'}`,
        `Layers: ${view.layers.join(', ') || 'None'}`,
        `Minor modes: ${view.minorModes.join(', ') || 'None'}`,
      ].join('\n');
      return { content: [{ type: 'text', text }], structuredContent: { ...view }, _meta: { widgetType: 'session' } };
    },
  };
}
