import { defineMcpUiResource } from '@agimon-ai/doompi-core/mcpFacet';

import { activityAppHtml, activityAppUri } from '../../../../../../generated/mcp-apps/activity';

export default defineMcpUiResource({
  uri: activityAppUri,
  name: 'doompi-tool-activity',
  description: 'Read-only activity and bounded output for remote tools without a custom widget.',
  mimeType: 'text/html;profile=mcp-app',
  _meta: {
    'doompi/defaultToolUi': true,
    ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
    'openai/widgetPrefersBorder': true,
    'openai/widgetDescription':
      'Shows the remote tool, safe input summary, status, and bounded output. Does not execute tools.',
    'openai/widgetCSP': { connect_domains: [], resource_domains: [] },
  },
  read: () => activityAppHtml,
});
