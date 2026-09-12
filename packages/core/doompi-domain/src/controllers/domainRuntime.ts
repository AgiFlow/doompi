import { getHarnessState } from '@agimon-ai/doompi-config/harnessStore';
import { requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import type { HarnessState } from '@agimon-ai/doompi-config/types';
import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-core/config';
import { type PiPluginContributions, type PiEventHandlers } from '@agimon-ai/doompi-core/pi-extension';
import { DOOM_TRANSITION_SERVICE } from '@agimon-ai/doompi-core/transition';
import { DOOM_VOICE_TOOLS_SERVICE, requireDoomVoiceToolsService } from '@agimon-ai/doompi-voice/voice-tools';
import { createVoiceReloadHandoffStore } from '@agimon-ai/doompi-voice/voice-reload-handoff';
import type { Context } from '@deepseek-ai/cordis';
import { DOOM_RESOURCE_CATALOG_ENTRY_TYPE, type ResourceCatalogProjection } from '@agimon-ai/doompi-core/skills';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createDomainsCommand } from './domainsCommand';
import { DOMAIN_STATUS_KEY, domainStatus } from '../services/domainText';
import type { DomainTelemetry } from '../types/telemetry';
import { createDomainCatalog } from './domainCatalog';
import { createDomainSwitchHandoffStore } from '../models/domainSwitchHandoff';
import { registerDomainVoiceCapabilities } from './voiceTool';

/**
 * Everything a switch needs beyond the session, loaded on first use.
 *
 * Every session registers /domains, but most never run it, so the plugin
 * materializer, the resource collector and the picker stay off the startup path.
 */
function lazyModules() {
  let apply: Promise<typeof import('./applyDomains')> | undefined;
  let journal: Promise<typeof import('@agimon-ai/doompi-config/piContext')> | undefined;
  let picker: Promise<typeof import('@agimon-ai/doompi-ui/matrix-picker')> | undefined;
  return {
    apply: () => (apply ??= import('./applyDomains')),
    journal: () => (journal ??= import('@agimon-ai/doompi-config/piContext')),
    picker: () => (picker ??= import('@agimon-ai/doompi-ui/matrix-picker')),
  };
}

export function activeDomainSkillPaths(state: Pick<HarnessState, 'skillDirectories'> = getHarnessState()): string[] {
  return [...state.skillDirectories];
}

/**
 * How long the catalog signal waits for Pi to finish applying a reload.
 *
 * Pi applies the paths every `resources_discover` handler returned only after
 * all of them have resolved, so the signal cannot be sent from the handler
 * itself: a microtask scheduled there still observes the previous catalog, and
 * a client that re-read on it would just cache the stale answer again. A timer
 * lands after the apply, and this one matches the settle the minor-mode catalog
 * publisher uses.
 */
const CATALOG_SETTLE_MS = 50;

/**
 * Answers `resources_discover` with the selected skills, and tells RPC clients
 * once a reload has rebuilt the catalog.
 *
 * Pi publishes nothing for a reload, so a client that caches `get_commands`,
 * which is what the web cockpit completes `$` from, otherwise keeps offering
 * the skills of the selection it replaced. This entry is that missing notice.
 * Every reload fires this event once whatever caused it, so the signal also
 * covers a switch that changed skills without touching domains.
 */
export function createResourceCatalogSignal(
  pi: ExtensionAPI,
  settleMs = CATALOG_SETTLE_MS,
): { events: PiEventHandlers; onStop(): void } {
  let settle: ReturnType<typeof setTimeout> | undefined;
  return {
    events: {
      resources_discover: (event) => {
        if (event.reason === 'reload') {
          clearTimeout(settle);
          settle = setTimeout(() => {
            settle = undefined;
            const projection: ResourceCatalogProjection = { version: 1, revision: Date.now() };
            pi.appendEntry(DOOM_RESOURCE_CATALOG_ENTRY_TYPE, projection);
          }, settleMs);
        }
        // The harness store is the process authority updated before reload begins.
        // Reading it directly avoids serving the previous Cordis session snapshot
        // while Pi is rebuilding resources for the replacement session.
        return { skillPaths: activeDomainSkillPaths() };
      },
    },
    onStop: () => clearTimeout(settle),
  };
}

interface DomainPluginConfig {
  readonly pi: ExtensionAPI;
  readonly telemetry: DomainTelemetry;
}

export function createDomainRuntime({ pi, telemetry }: DomainPluginConfig): PiPluginContributions<DomainTelemetry> {
  const load = lazyModules();

  let activeContext: Context | undefined;
  let runtimeInjection: ReturnType<Context['inject']> | undefined;
  const bindRuntime = (cordis: Context) => {
    runtimeInjection = cordis.inject([DOOM_CONFIG_SERVICE, DOOM_TRANSITION_SERVICE], (context) => {
      activeContext = context;
      return () => {
        if (activeContext === context) activeContext = undefined;
      };
    });
  };
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
  const bindVoice = (cordis: Context) => {
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
  };
  const signal = createResourceCatalogSignal(pi);
  return {
    services: [bindRuntime, bindVoice],
    onStop() {
      signal.onStop();
      handoffs.dispose();
    },
    onDispose() {
      signal.onStop();
      handoffs.dispose();
    },
    commands: [
      createDomainsCommand(pi, telemetry, {
        cordisContext: requireRuntimeContext,
        catalog,
        handoffs,
        reloadHandoffs,
        applyDomains: async (domains, state) => (await load.apply()).applyDomains(domains, state),
        loadConfigJournal: load.journal,
        loadPicker: load.picker,
      }),
    ],
    events: {
      ...signal.events,
      session_shutdown: (_event, ctx) => {
        handoffs.clearSession(ctx.sessionManager.getSessionId());
      },
      session_start: async (_event, ctx) => {
        await runtimeInjection?.await();
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
      },
    },
  };
}
