import { removeContextDetail, writeContextDetail } from '@agimon-ai/doompi-core/context-detail-store';
import { DOOM_CORDIS_SESSION_SERVICE, type DoomCordisSessionService } from '@agimon-ai/doompi-core/cordis-host';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-core/help';
import { DOOM_MCP_STATUS_SERVICE, readDoomMcpStatus } from '@agimon-ai/doompi-core/mcp-status';
import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';
import { DOOM_MINOR_MODE_CATALOG_SERVICE, requireMinorModeCatalog } from '@agimon-ai/doompi-minor-mode';
import type { Context } from '@deepseek-ai/cordis';

import { createContextPublisher, type ContextPublisher } from '../builders/cli/contextCatalog';
const HELP_CONTRIBUTION_SOURCE = '@agimon-ai/doompi';
export default definePiExtension('@agimon-ai/doompi/context-catalog', ({ pi }) => {
  let publisher: ContextPublisher | undefined;
  const bind = (cordis: Context): void => {
    cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
      const contribution = requireDoomHelpService(helpContext).register({
        source: HELP_CONTRIBUTION_SOURCE,
        moduleUrl: import.meta.url,
        skills: [
          {
            name: 'doompi-author-extension',
            description:
              'Create or update a DoomPi extension package inside the DoomPi monorepo or as an external npm package. Use for package layout, Pi discovery entries, shared Cordis lifecycle, package-owned Help, and extension verification.',
          },
        ],
      });
      return () => contribution.dispose();
    });

    cordis.inject([DOOM_CORDIS_SESSION_SERVICE, DOOM_MINOR_MODE_CATALOG_SERVICE], (context) => {
      const session = context.get(DOOM_CORDIS_SESSION_SERVICE) as DoomCordisSessionService;
      const catalog = requireMinorModeCatalog(context);
      const current = createContextPublisher(pi, context, {
        readMinorModes: () =>
          catalog
            .getSnapshot()
            .modes.filter(({ state }) => state.activation === 'active')
            .map(({ descriptor }) => ({ id: descriptor.id, label: descriptor.label })),
        readSessionId: () => session.sessionId,
        writeDetail: (sessionId, revision, items) => void writeContextDetail(sessionId, revision, items),
        removeDetail: removeContextDetail,
      });
      publisher = current;
      const publish = () => {
        void current.publish();
      };
      const unsubscribe = catalog.subscribe(publish);
      const timer = setTimeout(publish, 500);
      context.inject([DOOM_MCP_STATUS_SERVICE], (mcpContext) => {
        const release = readDoomMcpStatus(mcpContext)?.onChange?.(publish);
        publish();
        return release;
      });
      return () => {
        clearTimeout(timer);
        unsubscribe();
        current.dispose();
        if (publisher === current) publisher = undefined;
      };
    });
  };
  return {
    services: [bind],
    events: {
      turn_start() {
        void publisher?.publish();
      },
    },
  };
});
