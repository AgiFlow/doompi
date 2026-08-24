import { getHarnessState } from '@agimon-ai/doompi-config/harnessStore';
import { requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import type { HarnessState } from '@agimon-ai/doompi-config/types';
import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-extension-contracts/config';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import { DOOM_TRANSITION_SERVICE } from '@agimon-ai/doompi-extension-contracts/transition';
import {
  DOOM_VOICE_TOOLS_SERVICE,
  requireDoomVoiceToolsService,
} from '@agimon-ai/doompi-extension-contracts/voice-tools';
import { createVoiceReloadHandoffStore } from '@agimon-ai/doompi-extension-contracts/voice-reload-handoff';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerDomainsCommand } from '../../commands/domainsCommand.ts';
import { DOMAIN_STATUS_KEY, domainStatus } from '../../services/domainText.ts';
import { DOMAIN_SOURCE } from '../../types/domains.ts';
import type { DomainTelemetry } from '../../types/telemetry.ts';
import { createDomainCatalog } from '../domainCatalog.ts';
import { createDomainSwitchHandoffStore } from '../domainSwitchHandoff.ts';
import { createDomainTelemetry } from '../telemetry/logSinkTelemetry.ts';
import { registerDomainVoiceCapabilities } from './voiceTool.ts';

/**
 * Everything a switch needs beyond the session, loaded on first use.
 *
 * Every session registers /domains, but most never run it, so the plugin
 * materializer, the resource collector and the picker stay off the startup path.
 */
function lazyModules() {
  let apply: Promise<typeof import('../applyDomains.ts')> | undefined;
  let journal: Promise<typeof import('@agimon-ai/doompi-config/piContext')> | undefined;
  let picker: Promise<typeof import('@agimon-ai/doompi-ui/components/matrixPicker')> | undefined;
  return {
    apply: () => (apply ??= import('../applyDomains.ts')),
    journal: () => (journal ??= import('@agimon-ai/doompi-config/piContext')),
    picker: () => (picker ??= import('@agimon-ai/doompi-ui/components/matrixPicker')),
  };
}

export function activeDomainSkillPaths(state: Pick<HarnessState, 'skillDirectories'> = getHarnessState()): string[] {
  return [...state.skillDirectories];
}

interface DomainPluginConfig {
  readonly pi: ExtensionAPI;
  readonly telemetry: DomainTelemetry;
}

function domainPlugin(cordis: Context, { pi, telemetry }: DomainPluginConfig): void {
  const load = lazyModules();
  cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
    const help = requireDoomHelpService(helpContext).register({
      source: DOMAIN_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-author-domain',
          description:
            'Configure DoomPi plugin catalogs and domain resource selections in domains.yaml. Use when creating or editing .doom/domains.yaml or ~/.pi/.doom/domains.yaml, choosing local, Git, or npm plugins, filtering plugin resources, setting aliases or defaults, or verifying resolved domain composition.',
        },
      ],
    });
    return () => help.dispose();
  });

  let activeContext: Context | undefined;
  const runtimeInjection = cordis.inject([DOOM_CONFIG_SERVICE, DOOM_TRANSITION_SERVICE], (context) => {
    activeContext = context;
    return () => {
      if (activeContext === context) activeContext = undefined;
    };
  });
  const requireRuntimeContext = (): Context => {
    if (!activeContext) throw new Error('Doom domain runtime is waiting for the session config service.');
    return activeContext;
  };
  const catalog = createDomainCatalog(requireRuntimeContext);
  const handoffs = createDomainSwitchHandoffStore();
  const reloadHandoffs = createVoiceReloadHandoffStore({
    now: () => Date.now(),
    createToken: () => crypto.randomUUID(),
  });
  cordis.inject([DOOM_CONFIG_SERVICE, DOOM_TRANSITION_SERVICE, DOOM_VOICE_TOOLS_SERVICE], (voiceContext) =>
    registerDomainVoiceCapabilities(
      requireDoomVoiceToolsService(voiceContext),
      pi,
      catalog,
      handoffs,
      reloadHandoffs,
      () => voiceContext,
    ),
  );
  cordis.effect(function* () {
    registerDomainsCommand(pi, telemetry, {
      cordisContext: requireRuntimeContext,
      catalog,
      handoffs,
      reloadHandoffs,
      applyDomains: async (domains, state) => (await load.apply()).applyDomains(domains, state),
      loadConfigJournal: load.journal,
      loadPicker: load.picker,
    });

    // The harness store is the process authority updated before reload begins.
    // Reading it directly avoids serving the previous Cordis session snapshot while
    // Pi is rebuilding resources for the replacement session.
    pi.on('resources_discover', () => ({ skillPaths: activeDomainSkillPaths() }));

    pi.on('session_shutdown', (_event, ctx) => {
      handoffs.clearSession(ctx.sessionManager.getSessionId());
    });

    pi.on('session_start', async (_event, ctx) => {
      await runtimeInjection.await();
      const state = requireDoomConfigContext(requireRuntimeContext()).harness;
      // A switch reloads the session, so the start-time selection is the live one.
      ctx.ui.setStatus(DOMAIN_STATUS_KEY, domainStatus(state.domains));
      ctx.ui.addAutocompleteProvider((current) => ({
        triggerCharacters: [','],
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const repoRoot = state.root;
          const line = lines[cursorLine] ?? '';
          const completion = repoRoot ? await catalog.completions(repoRoot, line.slice(0, cursorCol)) : undefined;
          return completion ?? current.getSuggestions(lines, cursorLine, cursorCol, options);
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },
        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
          return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
        },
      }));
    });

    yield () => {
      handoffs.dispose();
    };
  }, DOMAIN_SOURCE);
}

/** The package's single standard Pi factory. */
export async function domainsExtension(
  pi: ExtensionAPI,
  telemetry: DomainTelemetry = createDomainTelemetry(),
): Promise<void> {
  const connection = await connectDoomCordisHost(pi, DOMAIN_SOURCE);
  const fiber = connection.root.plugin(domainPlugin, { pi, telemetry });
  try {
    await fiber;
  } catch (error) {
    try {
      await fiber.dispose();
    } finally {
      await connection.dispose();
    }
    throw error;
  }
  let disposal: Promise<void> | undefined;
  pi.on(
    'session_shutdown',
    () =>
      (disposal ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })()),
  );
}

export default domainsExtension;
