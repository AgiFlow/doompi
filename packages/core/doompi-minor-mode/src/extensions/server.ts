import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { DOOM_MINOR_MODE_CATALOG_SERVICE, DOOM_MINOR_MODE_ENTRY_TYPE } from '../schemas/mode';
import { createMinorModeCatalogHost } from '../services/catalog';
import { headlessMinorModeCommand } from '../services/headlessCommand';
import { projectMinorModes, restoreMinorModeSelection } from '../services/projection';

export default defineServerPlugin({
  name: '@agimon-ai/doompi-minor-mode',
  session({ agent }) {
    if (!agent) throw new Error('Minor modes require a session host');
    let started = false;
    let stopped = false;
    let pending = Promise.resolve();
    let published: string | undefined;
    const publish = (): Promise<void> => {
      const operation = pending.then(async () => {
        if (!started || stopped) return;
        const projection = projectMinorModes(catalog.getSnapshot(), 'headless');
        const key = JSON.stringify(projection);
        if (key === published) return;
        await agent.context.session.appendCustomEntry(DOOM_MINOR_MODE_ENTRY_TYPE, projection);
        published = key;
      });
      pending = operation.catch(() => undefined);
      return operation;
    };
    const catalog = createMinorModeCatalogHost({
      sessionKind: 'headless',
      context: { sessionManager: { getSessionId: () => agent.context.sessionId } },
      async routeInvocation(_request, _source, invoke) {
        agent.assertActive();
        const response = await invoke();
        await publish();
        return response;
      },
    });
    return {
      commands: [headlessMinorModeCommand(catalog)],
      services: [
        (context) => {
          context.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, catalog);
          context.effect(() =>
            catalog.subscribe(() => {
              void publish().catch(async (error) => {
                if (stopped) return;
                await agent.context.client.notify({
                  body: `Minor-mode projection failed: ${String(error)}`,
                  level: 'error',
                });
              });
            }),
          );
          context.effect(() => agent.subscribeSelection(publish));
        },
      ],
      hooks: [
        {
          event: 'session_shutdown',
          async handle() {
            stopped = true;
            await pending;
          },
        },
        {
          event: 'session_start',
          async handle() {
            const entries = await agent.context.session.entries({
              type: 'custom',
              customType: DOOM_MINOR_MODE_ENTRY_TYPE,
            });
            const values = restoreMinorModeSelection(entries);
            if (values) await agent.changeSelection({ axis: 'state', key: 'minor-mode', values });
            started = true;
            await publish();
          },
        },
      ],
      async onDispose() {
        stopped = true;
        catalog.dispose();
        await pending;
      },
    };
  },
});
