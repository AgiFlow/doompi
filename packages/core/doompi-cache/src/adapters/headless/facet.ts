import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessHook,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { sha256Base64Url } from '../node/digest.ts';
import { canonicalJson } from '../../services/canonical.ts';
import { createPromptCacheKey, createPromptCacheModelFingerprint } from '../../services/namespace.ts';
import { rewritePromptCacheKey } from '../../services/providerPolicy.ts';
import type { PromptCacheModelIdentity } from '../../types/cache.ts';

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function modelIdentity(
  model: { provider: string; id: string } | undefined,
  payload: unknown,
): PromptCacheModelIdentity {
  const request = record(payload);
  return {
    virtualProvider: model?.provider,
    virtualModel: model?.id,
    api: typeof request.api === 'string' ? request.api : undefined,
    wireModel: typeof request.model === 'string' ? request.model : undefined,
  };
}

function cacheNamespace(context: { sessionId: string; selection: Record<string, unknown> }): string {
  return `dph_${sha256Base64Url(canonicalJson({ version: 1, session: context.sessionId, selection: context.selection }))}`;
}

export const cacheHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const resource: DoomHeadlessResource = {
      name: 'doompi/prompt-cache-selection',
      kind: 'context',
      read: (execution) =>
        JSON.stringify(
          {
            sessionId: execution.sessionId,
            selection: execution.selection,
            model: execution.model,
          },
          null,
          2,
        ),
    };
    const hooks: DoomHeadlessHook[] = [
      {
        event: 'before_provider_request',
        handle(event, execution) {
          const payload = record(event.payload);
          const identity = modelIdentity(execution.model, payload);
          const modelFingerprint = createPromptCacheModelFingerprint(identity, sha256Base64Url);
          const key = createPromptCacheKey(
            cacheNamespace({
              sessionId: execution.sessionId,
              selection: execution.selection as unknown as Record<string, unknown>,
            }),
            'parent',
            modelFingerprint,
            sha256Base64Url,
          );
          return rewritePromptCacheKey(payload, identity.api, key, true);
        },
      },
      {
        event: 'session_shutdown',
        handle(_event, execution) {
          execution.client.setStatus('doom-cache', undefined);
        },
      },
    ];
    const registrations = [host.registerResource(resource), ...hooks.map((hook) => host.registerHook(hook))];
    return () => {
      for (const registration of registrations) registration.dispose();
    };
  },
};
