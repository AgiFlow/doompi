import { getHarnessState } from '@agimon-ai/doompi-config/harnessStore';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  readMinorModeCatalog,
  type MinorModeRecord,
} from '@agimon-ai/doompi-minor-mode';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { KEY_SUFFIX_LENGTH } from '../../constants/cache';
import {
  DOOMPI_PROMPT_CACHE_CHILD_PROJECTION_ENV,
  DOOMPI_PROMPT_CACHE_PARENT_NAMESPACE_ENV,
  DOOMPI_PROMPT_CACHE_ROOT_SESSION_ENV,
  PI_CACHE_RETENTION_ENV,
  PI_CACHE_RETENTION_LONG,
} from '../../constants/environment';
import type { PromptCacheMinorModeState, PromptCacheModelIdentity } from '../../types/cache';
import type { CacheExtensionDependencies } from '../../types/extension';
import { sha256Base64Url } from '../digest';
import { OwnedEnvironmentValue } from '../environment';
import {
  createParentPromptCacheNamespace,
  createPromptCacheKey,
  createPromptCacheModelFingerprint,
  createRootSessionIdentity,
} from '../namespace';
import { optimizerAllowsPromptCacheKey } from '../optimizerPolicy';
import { normalizePromptCacheUsage } from '../promptCacheUsage';
import { classifyPromptCacheCapability, requestedPromptCacheRetention, rewritePromptCacheKey } from '../providerPolicy';
import type { CacheRuntime, OptimizerModule } from './type';

type BeforeProviderEvent = { readonly payload?: unknown };
type MessageEndEvent = { readonly message?: unknown };
type MinorModeStateWithVariant = MinorModeRecord['state'] & { readonly modelContextVariant?: string };

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

export function createCacheRuntime(dependencies: CacheExtensionDependencies, optimizer: OptimizerModule): CacheRuntime {
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

  const plugin = (cordis: Context): void => {
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
  };
  return {
    plugin,
    events: {
      session_start: (_event, ctx) => {
        if (!isProjectedChild) {
          rootSessionId = stringValue(ctx.sessionManager.getSessionId());
          refreshParentNamespace();
        }
      },

      before_provider_request: (event: BeforeProviderEvent, ctx: ExtensionContext) => {
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
        const rewritten = rewritePromptCacheKey(
          event.payload,
          identity.api,
          key,
          optimizerAllowsPromptCacheKey(optimizer),
        );
        dependencies.telemetry.beginRequest({
          capability: classifyPromptCacheCapability(identity),
          namespace,
          modelFingerprint,
          requestedRetention: requestedRetention(rewritten ?? event.payload),
          ...(rewritten ? { keySuffix: key.slice(-KEY_SUFFIX_LENGTH) } : {}),
        });
        return rewritten;
      },

      message_end: (event: MessageEndEvent) => {
        if (isErrorMessage(event.message)) return;
        const usage = normalizePromptCacheUsage(event.message);
        if (usage) dependencies.telemetry.observe(usage, dependencies.now());
      },
    },
    dispose: () => {
      parentNamespaceEnvironment.restore();
      rootSessionEnvironment.restore();
      dependencies.telemetry.reset();
    },
  };
}
