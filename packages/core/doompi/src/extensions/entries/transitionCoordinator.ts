import fs from 'node:fs';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { readDoomConfigContextGeneration, requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-extension-contracts/config';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { alreadyComposed } from '@agimon-ai/doompi-extension-contracts/child-process';
import {
  connectDoomCordisHost,
  DOOM_CORDIS_SESSION_SERVICE,
  type DoomCordisSessionService,
} from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { MUTE_ENV } from '../../adapters/compositionState.ts';
import { createMapResolvers, readSyncState } from '../../adapters/syncState.ts';
import {
  createLayerResolvers,
  type ExtensionLayerResolvers,
  PERSONA_ENTRY,
  resolveExtensionComposition,
} from '../../services/extensionAssembler.ts';
import {
  type DoomTransitionCoordinator,
  DOOM_TRANSITION_SERVICE,
  MINOR_MODE_CATALOG_SERVICE,
  requireDoomTransitionCoordinator,
  readMinorModeCatalogHost,
} from '@agimon-ai/doompi-extension-contracts/transition';
import { createDoomTransitionCoordinator } from '../../services/transitionCoordinator.ts';
import type { Context } from '@deepseek-ai/cordis';
import type {
  TransitionSelectionSnapshot,
  TransitionSynchronization,
} from '@agimon-ai/doompi-extension-contracts/transition';

const ENABLED_FLAG = '1';
const DEFAULT_PRESET = 'default';
const PACKAGE_SOURCE = '@agimon-ai/doompi/transition-coordinator';

export function currentTransitionSynchronization(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  _currentMajorMode?: string,
): TransitionSynchronization {
  if (!alreadyComposed(environment)) return { kind: 'launcher' };
  try {
    const state = readSyncState(repositoryRoot, environment.HOME);
    if (!state || Object.keys(state.resolved).length === 0) {
      return {
        kind: 'synchronized',
        resolutionAvailable: false,
        availableCompositionFingerprints: [],
      };
    }
    const resolvedPaths = Object.values(state.resolved).filter((entry) => entry.startsWith('/'));
    return {
      kind: 'synchronized',
      resolutionAvailable: resolvedPaths.every((entry) => fs.existsSync(entry)),
      availableCompositionFingerprints: Object.entries(state.bundles ?? {})
        .filter(([, artifact]) => fs.existsSync(artifact))
        .map(([fingerprint]) => fingerprint),
    };
  } catch {
    return {
      kind: 'synchronized',
      resolutionAvailable: false,
      availableCompositionFingerprints: [],
    };
  }
}

function compositionResolver(
  repositoryRoot: string,
  harness: ReturnType<typeof requireDoomConfigContext>['harness'],
  resolvers: ExtensionLayerResolvers,
  preset: string,
): (selection: TransitionSelectionSnapshot) =>
  | {
      readonly fingerprint: string;
      readonly parentActivation: readonly string[];
      readonly childActivation: readonly string[];
    }
  | undefined {
  const majorModesConfig = loadMajorModesConfig(repositoryRoot);
  return (selection) => {
    try {
      const composition = resolveExtensionComposition({
        agents: harness.agents,
        autoStop: false,
        mute: process.env[MUTE_ENV] === ENABLED_FLAG,
        preset,
        personaEntry: resolvers.packageEntry(PERSONA_ENTRY),
        majorMode: selection.majorMode,
        layers: [...selection.layers],
        majorModesConfig,
        resolvers,
      });
      return {
        fingerprint: composition.fingerprint,
        parentActivation: [...composition.parentActivation],
        childActivation: [...composition.childActivation],
      };
    } catch {
      return undefined;
    }
  };
}

export async function transitionCoordinatorExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(transitionCoordinatorPlugin);
  try {
    await fiber;
  } catch (error) {
    await fiber.dispose();
    await connection.dispose();
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

function transitionCoordinatorPlugin(cordis: Context): void {
  cordis.inject([DOOM_CORDIS_SESSION_SERVICE, DOOM_CONFIG_SERVICE], (sessionContext) => {
    const session = sessionContext.get(DOOM_CORDIS_SESSION_SERVICE) as DoomCordisSessionService;
    const context = session.context;
    const sessionId = session.sessionId;
    const doomConfig = requireDoomConfigContext(sessionContext);
    const harness = doomConfig.harness;
    const repositoryRoot = harness.root ?? context.cwd;
    const majorModesConfig = loadMajorModesConfig(repositoryRoot);
    const state = alreadyComposed() ? readSyncState(repositoryRoot, process.env.HOME) : undefined;
    const resolvers = state ? createMapResolvers(state.resolved, state.compiled) : createLayerResolvers(repositoryRoot);
    const resolveComposition = compositionResolver(
      repositoryRoot,
      harness,
      resolvers,
      state?.selection.preset ?? DEFAULT_PRESET,
    );
    const currentSelection: TransitionSelectionSnapshot = {
      domains: [...harness.domains],
      majorMode: harness.majorMode,
      layers: [...harness.layers],
      profile: harness.profile,
      childActivation: [...harness.childExtensions],
    };
    const currentComposition = resolveComposition(currentSelection);
    const hostGeneration = `doom-transition:${crypto.randomUUID()}`;
    const coordinator: DoomTransitionCoordinator = createDoomTransitionCoordinator({
      sessionId,
      hostGeneration,
      generation: () => ({
        sessionId,
        hostGeneration,
        configGeneration: readDoomConfigContextGeneration(sessionContext),
      }),
      classifierContext: () => ({
        current: {
          ...currentSelection,
          ...(currentComposition
            ? {
                compositionFingerprint: currentComposition.fingerprint,
                parentActivation: [...currentComposition.parentActivation],
                childActivation: [...currentComposition.childActivation],
              }
            : {}),
        },
        majorModesConfig,
        hooksEnabled: harness.hooks,
        synchronization: currentTransitionSynchronization(repositoryRoot, process.env, harness.majorMode),
        resolveComposition,
      }),
    });
    sessionContext.provide(DOOM_TRANSITION_SERVICE, coordinator);
    sessionContext.inject([DOOM_TRANSITION_SERVICE, MINOR_MODE_CATALOG_SERVICE], (catalogContext) => {
      const activeCoordinator = requireDoomTransitionCoordinator(catalogContext);
      const catalog = readMinorModeCatalogHost(catalogContext);
      return catalog ? activeCoordinator.attachMinorModeCatalog(catalog) : undefined;
    });
    return () => coordinator.dispose();
  });
}

export default transitionCoordinatorExtension;
