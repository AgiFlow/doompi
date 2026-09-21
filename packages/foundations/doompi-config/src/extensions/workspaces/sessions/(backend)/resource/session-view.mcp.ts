import { defineMcpUiResource } from '@agimon-ai/doompi-core/mcp-facet';

import { sessionAppHtml, sessionAppUri } from '../../../../../../generated/mcp-apps/session';

export default defineMcpUiResource({
  uri: sessionAppUri,
  name: 'doompi-session-view',
  description: 'Read-only Doompi session summary with an explicit refresh action.',
  mimeType: 'text/html;profile=mcp-app',
  _meta: {
    ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
    'openai/widgetPrefersBorder': true,
    'openai/widgetCSP': { connect_domains: [], resource_domains: [] },
  },
  read: () => sessionAppHtml,
});
