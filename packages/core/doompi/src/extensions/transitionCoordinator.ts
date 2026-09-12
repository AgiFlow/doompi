import { extensionLayers } from '../composition/transitionLayers';
import fs from 'node:fs';
import { loadMajorModesConfig, filterHookDisabledLayers, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import { readDoomConfigContextGeneration, requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-core/config';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { alreadyComposed } from '@agimon-ai/doompi-core/child-process';
import {
  connectDoomCordisHost,
  DOOM_CORDIS_SESSION_SERVICE,
  type DoomCordisSessionService,
} from '@agimon-ai/doompi-core/cordis-host';
import { MUTE_ENV } from '../builders/cli/compositionState';
import { readLauncherComposition } from '../builders/cli/launcherComposition';
import { createMapResolvers, readSyncState } from '../composition/syncState';
import {
  createLayerResolvers,
  type ExtensionLayerResolvers,
  PERSONA_ENTRY,
  resolveExtensionComposition,
} from '../builders/cli/extensionAssembler';
import { type DoomTransitionCoordinator, DOOM_TRANSITION_SERVICE } from '@agimon-ai/doompi-core/transition';
import { createDoomTransitionCoordinator } from '@agimon-ai/doompi-core/transition-coordinator';
import type { Context } from '@deepseek-ai/cordis';
import type { TransitionSelectionSnapshot, TransitionSynchronization } from '@agimon-ai/doompi-core/transition';

const ENABLED_FLAG = '1';
const DEFAULT_PRESET = 'default';
const PACKAGE_SOURCE = '@agimon-ai/doompi/transition-coordinator';

export function currentTransitionSynchronization(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  _currentMajorMode?: string,
): TransitionSynchronization {
  // A composing launcher session recomposes on reload, so it is neither the
  // frozen launcher case nor the synced one. Checked before `alreadyComposed`
  // because such a session never runs the synced composer that sets it.
  if (readLauncherComposition(environment)) return { kind: 'launcher-composed' };
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

/**
 * The launch values that enter parent activation alongside the selection.
 *
 * They are fixed for the process but not all readable from the environment, so
 * a composing launcher session supplies them from its record. Getting them
 * wrong does not change which disposition is chosen, because both sides of
 * every comparison share the error, but it does publish a fingerprint that no
 * other reader of harness state agrees with.
 */
interface CompositionIdentity {
  agents: boolean;
  autoStop: boolean;
  mute: boolean;
  preset: string;
}

function compositionResolver(
  repositoryRoot: string,
  identity: CompositionIdentity,
  resolvers: ExtensionLayerResolvers,
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
        agents: identity.agents,
        autoStop: identity.autoStop,
        mute: identity.mute,
        preset: identity.preset,
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
    // A composing launcher session records the launch identity it was started
    // with; every other session recovers what it can from the environment.
    const launcher = readLauncherComposition();
    const resolveComposition = compositionResolver(
      repositoryRoot,
      launcher
        ? { agents: launcher.agents, autoStop: launcher.autoStop, mute: launcher.mute, preset: launcher.preset }
        : {
            agents: harness.agents,
            autoStop: false,
            mute: process.env[MUTE_ENV] === ENABLED_FLAG,
            preset: state?.selection.preset ?? DEFAULT_PRESET,
          },
      resolvers,
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
        resolveLayers: (majorMode) =>
          filterHookDisabledLayers(majorModesConfig, resolveLayers(majorModesConfig, majorMode), harness.hooks),
        extensionLayers: (layers) => extensionLayers(majorModesConfig, layers),
        synchronization: currentTransitionSynchronization(repositoryRoot, process.env, harness.majorMode),
        resolveComposition,
      }),
    });
    sessionContext.provide(DOOM_TRANSITION_SERVICE, coordinator);

    return () => coordinator.dispose();
  });
}

export default transitionCoordinatorExtension;
