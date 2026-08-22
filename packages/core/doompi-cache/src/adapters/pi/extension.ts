import { getHarnessState } from '@agimon-ai/doompi-config/harnessStore';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  readMinorModeCatalog,
  type MinorModeRecord,
} from '@agimon-ai/doompi-extension-contracts/mode';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createCacheContainer } from '../../container/index.ts';
import { OwnedEnvironmentValue } from '../node/environment.ts';
import { sha256Base64Url } from '../node/digest.ts';
import { PromptCacheTelemetryService } from '../../providers/promptCacheTelemetry.ts';
import {
  createParentPromptCacheNamespace,
  createPromptCacheKey,
  createPromptCacheModelFingerprint,
  createRootSessionIdentity,
} from '../../services/namespace.ts';
import { optimizerAllowsPromptCacheKey } from '../../services/optimizerPolicy.ts';
import {
  classifyPromptCacheCapability,
  requestedPromptCacheRetention,
  rewritePromptCacheKey,
} from '../../services/providerPolicy.ts';
import { normalizePromptCacheUsage } from '../../services/promptCacheUsage.ts';
import type { PromptCacheMinorModeState, PromptCacheModelIdentity } from '../../types/cache.ts';
import {
  DOOMPI_PROMPT_CACHE_CHILD_PROJECTION_ENV,
  DOOMPI_PROMPT_CACHE_PARENT_NAMESPACE_ENV,
  DOOMPI_PROMPT_CACHE_ROOT_SESSION_ENV,
  PI_CACHE_RETENTION_ENV,
  PI_CACHE_RETENTION_LONG,
} from '../../types/environment.ts';
import type { CacheExtensionDependencies } from '../../types/extension.ts';

const PACKAGE_SOURCE = '@agimon-ai/doompi-cache';
const KEY_SUFFIX_LENGTH = 8;

type BeforeProviderEvent = { readonly payload?: unknown };
type MessageEndEvent = { readonly message?: unknown };
type MinorModeStateWithVariant = MinorModeRecord['state'] & { readonly modelContextVariant?: string };
type OptimizerModule = typeof import('#doompi-cache-optimizer-source');

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function minorModeState(record: MinorModeRecord): PromptCacheMinorModeState {
  const state = record.state as MinorModeStateWithVariant;
  return {
    source: record.descriptor.source,
    id: record.descriptor.id,
    activation: state.activation,
    ...(state.modelContextVariant ? { modelContextVariant: state.modelContextVariant } : {}),
  };
}

function modelIdentity(ctx: ExtensionContext, payload: unknown): PromptCacheModelIdentity {
  const model = recordValue(ctx.model);
  const request = recordValue(payload);
  return {
    virtualProvider: stringValue(model?.provider),
    virtualModel: stringValue(model?.id),
    api: stringValue(model?.api),
    baseUrl: stringValue(model?.baseUrl),
    wireModel: stringValue(request?.model),
  };
}

function isErrorMessage(message: unknown): boolean {
  const record = recordValue(message);
  return record?.stopReason === 'error' || record?.stopReason === 'aborted';
}

function requestedRetention(payload: unknown): string | undefined {
  return (
    requestedPromptCacheRetention(payload) ??
    (process.env[PI_CACHE_RETENTION_ENV] === PI_CACHE_RETENTION_LONG ? PI_CACHE_RETENTION_LONG : undefined)
  );
}

function installCacheRuntime(
  cordis: Context,
  pi: ExtensionAPI,
  dependencies: CacheExtensionDependencies,
  optimizer: OptimizerModule,
): () => void {
  const parentNamespaceEnvironment = new OwnedEnvironmentValue(DOOMPI_PROMPT_CACHE_PARENT_NAMESPACE_ENV);
  const rootSessionEnvironment = new OwnedEnvironmentValue(DOOMPI_PROMPT_CACHE_ROOT_SESSION_ENV);
  const projectedParentNamespace = stringValue(process.env[DOOMPI_PROMPT_CACHE_PARENT_NAMESPACE_ENV]);
  const childProjection = stringValue(process.env[DOOMPI_PROMPT_CACHE_CHILD_PROJECTION_ENV]);
  const isProjectedChild = Boolean(projectedParentNamespace && childProjection);
  let rootSessionId: string | undefined;
  let parentNamespace = projectedParentNamespace;
  let minorModes: readonly PromptCacheMinorModeState[] = [];

  const refreshParentNamespace = (): string | undefined => {
    if (isProjectedChild) return parentNamespace;
    if (!rootSessionId) return undefined;
    const harness = getHarnessState();
    parentNamespace = createParentPromptCacheNamespace(
      {
        rootSessionId,
        compositionFingerprint: harness.compositionFingerprint,
        majorMode: harness.majorMode,
        domains: harness.domains,
        profile: harness.profile,
        persona: harness.personaFile,
        minorModes,
      },
      sha256Base64Url,
    );
    parentNamespaceEnvironment.set(parentNamespace);
    rootSessionEnvironment.set(createRootSessionIdentity(rootSessionId, sha256Base64Url));
    return parentNamespace;
  };

  cordis.inject([DOOM_MINOR_MODE_CATALOG_SERVICE], (context) => {
    if (isProjectedChild) return undefined;
    const catalog = readMinorModeCatalog(context);
    if (!catalog) return undefined;
    const refreshModes = (): void => {
      minorModes = catalog.getSnapshot().modes.map(minorModeState);
      refreshParentNamespace();
    };
    refreshModes();
    return catalog.subscribe(refreshModes);
  });

  pi.on('session_start', (_event, ctx) => {
    if (!isProjectedChild) {
      rootSessionId = stringValue(ctx.sessionManager.getSessionId());
      refreshParentNamespace();
    }
  });

  pi.on('before_provider_request', (event: BeforeProviderEvent, ctx: ExtensionContext) => {
    const namespace = isProjectedChild ? projectedParentNamespace : refreshParentNamespace();
    if (!namespace) return undefined;

    const identity = modelIdentity(ctx, event.payload);
    const modelFingerprint = createPromptCacheModelFingerprint(identity, sha256Base64Url);
    const key = createPromptCacheKey(
      namespace,
      isProjectedChild ? 'child' : 'parent',
      modelFingerprint,
      sha256Base64Url,
      childProjection,
    );
    const rewritten = rewritePromptCacheKey(event.payload, identity.api, key, optimizerAllowsPromptCacheKey(optimizer));
    dependencies.telemetry.beginRequest({
      capability: classifyPromptCacheCapability(identity),
      namespace,
      modelFingerprint,
      requestedRetention: requestedRetention(rewritten ?? event.payload),
      ...(rewritten ? { keySuffix: key.slice(-KEY_SUFFIX_LENGTH) } : {}),
    });
    return rewritten;
  });

  pi.on('message_end', (event: MessageEndEvent) => {
    if (isErrorMessage(event.message)) return;
    const usage = normalizePromptCacheUsage(event.message);
    if (usage) dependencies.telemetry.observe(usage, dependencies.now());
  });

  return () => {
    parentNamespaceEnvironment.restore();
    rootSessionEnvironment.restore();
    dependencies.telemetry.reset();
  };
}

interface CachePluginConfig {
  readonly pi: ExtensionAPI;
  readonly dependencies: CacheExtensionDependencies;
  readonly optimizer: OptimizerModule;
}

function cachePlugin(cordis: Context, config: CachePluginConfig): void {
  cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
    const contribution = requireDoomHelpService(helpContext).register({
      source: PACKAGE_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-use-cache',
          description: 'Inspect DoomPi provider prompt cache policy, routing identity, and provider-observed usage.',
        },
      ],
    });
    return () => contribution.dispose();
  });
  cordis.effect(function* () {
    new PromptCacheTelemetryService(cordis, config.dependencies.telemetry);
    yield installCacheRuntime(cordis, config.pi, config.dependencies, config.optimizer);
  }, PACKAGE_SOURCE);
}

export async function activateCacheExtension(
  pi: ExtensionAPI,
  dependencies: CacheExtensionDependencies = createCacheContainer(),
): Promise<void> {
  const optimizer = await import('#doompi-cache-optimizer-source');
  if (typeof optimizer.default !== 'function')
    throw new Error('Pi Cache Optimizer does not export an extension factory.');
  await optimizer.default(pi);

  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(cachePlugin, { pi, dependencies, optimizer });
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

export default activateCacheExtension;
