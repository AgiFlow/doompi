import os from 'node:os';

import { requireHarnessRoot } from '@agimon-ai/doompi-config/harnessStore';
import { requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-core/config';
import { removeContextDetail, writeContextDetail } from '@agimon-ai/doompi-core/contextDetailStore';
import { DOOM_CORDIS_SESSION_SERVICE, type DoomCordisSessionService } from '@agimon-ai/doompi-core/cordisHost';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-core/help';
import { createPiHelpToolGate } from '@agimon-ai/doompi-core/help';
import { DOOM_MCP_STATUS_SERVICE, readDoomMcpStatus } from '@agimon-ai/doompi-core/mcpStatus';
import { definePiExtension } from '@agimon-ai/doompi-core/piExtension';
import { DOOM_MINOR_MODE_CATALOG_SERVICE, requireMinorModeCatalog } from '@agimon-ai/doompi-minor-mode';
import type { Context } from '@deepseek-ai/cordis';

import { createContextPublisher, type ContextPublisher } from '../builders/cli/contextCatalog';
import { createSetupDiagnosticsTool, DIAGNOSE_SETUP_NAME, type SetupDiagnosticScope } from './setupDiagnostics';

const HELP_CONTRIBUTION_SOURCE = '@agimon-ai/doompi';
export default definePiExtension('@agimon-ai/doompi/context-catalog', ({ pi }) => {
  let publisher: ContextPublisher | undefined;
  let readSetupScope: (() => SetupDiagnosticScope) | undefined;
  const helpGate = createPiHelpToolGate(HELP_CONTRIBUTION_SOURCE, [DIAGNOSE_SETUP_NAME]);
  /**
   * A handler's context, kept so the prompt can be read when the composition is
   * published rather than only when an event fires.
   *
   * `getSystemPrompt` reads the session's live state and refuses only once the
   * runner has been replaced, so a retained context answers for the session it
   * came from or throws. Publishing happens on a timer and on catalog changes,
   * neither of which carries a context of its own.
   */
  let promptContext: { getSystemPrompt: () => string } | undefined;
  /** Pi hands out the base prompt until a turn replaces it with the one it sent. */
  let turned = false;
  const bind = (cordis: Context): void => {
    cordis.inject([DOOM_CONFIG_SERVICE, DOOM_CORDIS_SESSION_SERVICE], (context) => {
      const session = context.get(DOOM_CORDIS_SESSION_SERVICE) as DoomCordisSessionService;
      const read = (): SetupDiagnosticScope => {
        const harness = requireDoomConfigContext(context).harness;
        return {
          repoRoot: requireHarnessRoot(harness),
          cwd: session.context.cwd,
          environment: { HOME: os.homedir(), ...harness.profileEnvironment },
          selection: { majorMode: harness.majorMode, domains: [...harness.domains], profile: harness.profile },
        };
      };
      readSetupScope = read;
      return () => {
        if (readSetupScope === read) readSetupScope = undefined;
      };
    });
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
        readSystemPrompt: () => {
          try {
            const text = promptContext?.getSystemPrompt();
            return text === undefined || text === '' ? undefined : { text, stage: turned ? 'effective' : 'base' };
          } catch {
            // A context from a retired runner is stale, not fatal: the panel
            // reports no prompt until the next event hands over a live one.
            return undefined;
          }
        },
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
    services: [...helpGate.services, bind],
    tools: [
      createSetupDiagnosticsTool(
        () => {
          if (!readSetupScope) throw new Error('Setup diagnostics require the current session configuration.');
          return readSetupScope();
        },
        (signal) => helpGate.assertActive(DIAGNOSE_SETUP_NAME, signal),
      ),
    ],
    onStart: helpGate.onStart,
    events: {
      session_start(_event, ctx) {
        promptContext = ctx;
        void publisher?.publish();
      },
      turn_start(_event, ctx) {
        promptContext = ctx;
        turned = true;
        void publisher?.publish();
      },
    },
  };
});
