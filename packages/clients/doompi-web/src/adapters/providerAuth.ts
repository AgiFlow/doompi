import crypto from 'node:crypto';
import { createLoginFlow, type LoginFlow } from '../services/loginFlow.ts';
import type {
  AuthMethodType,
  AuthRuntime,
  AuthRuntimeProvider,
  LoginFlowSnapshot,
  ProviderAuthMethod,
  ProviderAuthSummary,
} from '../types/auth.ts';

/** Matches the timeout Pi's own /logout gives the credential store. */
const LOGOUT_TIMEOUT_MS = 15_000;

export type StartLoginOutcome =
  | { ok: true; flow: LoginFlowSnapshot }
  | { ok: false; code: 'unknown_provider' | 'unsupported_method' | 'busy'; error: string };

export type LogoutOutcome = { ok: true } | { ok: false; code: 'unknown_provider' | 'runtime'; error: string };

export type AnswerOutcome = 'answered' | 'unknown_flow' | 'not_waiting';

/** Provider credentials as the settings page sees them, backed by one Pi runtime. */
export interface ProviderAuth {
  /** Every provider Pi knows, with its current auth state; re-read from disk each call. */
  listProviders(): Promise<ProviderAuthSummary[]>;
  startLogin(providerId: string, type: AuthMethodType): Promise<StartLoginOutcome>;
  getLogin(flowId: string): LoginFlowSnapshot | undefined;
  answerLogin(flowId: string, promptId: string, value: string): AnswerOutcome;
  /** Cancels the flow and returns how it stands, or undefined for an unknown flow. */
  cancelLogin(flowId: string): LoginFlowSnapshot | undefined;
  logout(providerId: string): Promise<LogoutOutcome>;
  /** Abandons every running flow; the hub is shutting down. */
  close(): void;
}

export interface ProviderAuthOptions {
  /** Test seam over Pi's ModelRuntime; the default loads the real one over auth.json. */
  runtime?: () => Promise<AuthRuntime>;
  onNotice?: (message: string) => void;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pi's runtime, imported on first use: the hub should come up without paying
 * for the provider catalog, and a machine without Pi installed still serves
 * sessions, just not the providers page.
 */
async function loadPiRuntime(): Promise<AuthRuntime> {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  return ModelRuntime.create();
}

/** The methods a page can start, in the order the TUI's selector lists them. */
function methodsOf(provider: AuthRuntimeProvider): ProviderAuthMethod[] {
  const methods: ProviderAuthMethod[] = [];
  const { oauth, apiKey } = provider.auth;
  if (oauth) methods.push({ type: 'oauth', label: oauth.loginLabel ?? oauth.name });
  if (apiKey?.login) methods.push({ type: 'api_key', label: apiKey.name });
  return methods;
}

/** Mirrors the status the TUI's login selector shows beside each provider. */
function summarize(runtime: AuthRuntime, provider: AuthRuntimeProvider): ProviderAuthSummary {
  const summary: ProviderAuthSummary = { id: provider.id, name: provider.name, methods: methodsOf(provider) };
  const status = runtime.getProviderAuthStatus(provider.id);
  if (status.configured) {
    summary.authenticated = {
      type: runtime.isUsingOAuth(provider.id) ? 'oauth' : 'api_key',
      source: status.label ?? status.source,
    };
  }
  return summary;
}

export function createProviderAuth(options: ProviderAuthOptions = {}): ProviderAuth {
  const notice = options.onNotice ?? ((): void => {});
  const load = options.runtime ?? loadPiRuntime;
  const flows = new Map<string, LoginFlow>();
  let loading: Promise<AuthRuntime> | undefined;

  // A failed load is forgotten so the next request tries again rather than
  // pinning the page on a startup error.
  const runtime = (): Promise<AuthRuntime> => {
    loading ??= load().catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
    return loading;
  };

  const findProvider = (current: AuthRuntime, providerId: string): AuthRuntimeProvider | undefined =>
    current.getProviders().find((provider) => provider.id === providerId);

  const runningFor = (providerId: string): LoginFlow | undefined =>
    [...flows.values()].find((flow) => flow.providerId === providerId && flow.snapshot().status === 'running');

  return {
    async listProviders() {
      const current = await runtime();
      // Another client may have stored a credential since the last look (a
      // TUI /login, a hand-edited auth.json); the stale snapshot still lists
      // on a failed refresh, which the notice explains.
      try {
        await current.refresh({ allowNetwork: false });
      } catch (error) {
        notice(`provider auth refresh failed: ${describe(error)}`);
      }
      return current
        .getProviders()
        .map((provider) => summarize(current, provider))
        .sort((left, right) => left.name.localeCompare(right.name));
    },

    async startLogin(providerId, type) {
      const current = await runtime();
      const provider = findProvider(current, providerId);
      if (!provider) return { ok: false, code: 'unknown_provider', error: `Unknown provider: ${providerId}` };
      if (!methodsOf(provider).some((method) => method.type === type)) {
        return { ok: false, code: 'unsupported_method', error: `${provider.name} has no ${type} login.` };
      }
      if (runningFor(providerId)) {
        return { ok: false, code: 'busy', error: `A login for ${provider.name} is already in progress.` };
      }
      // Finished flows live until the next start: long enough for the page to
      // read how they ended, short enough that the map never grows.
      for (const [id, flow] of flows) if (flow.snapshot().status !== 'running') flows.delete(id);

      const flow = createLoginFlow({ id: crypto.randomUUID(), providerId, providerName: provider.name, type });
      flows.set(flow.id, flow);
      current.login(providerId, type, flow.interaction).then(
        () => {
          flow.settle({ ok: true });
          notice(`signed in to ${provider.name} (${type})`);
        },
        (error: unknown) => {
          flow.settle({ ok: false, error: describe(error) });
        },
      );
      return { ok: true, flow: flow.snapshot() };
    },

    getLogin(flowId) {
      return flows.get(flowId)?.snapshot();
    },

    answerLogin(flowId, promptId, value) {
      const flow = flows.get(flowId);
      if (!flow) return 'unknown_flow';
      return flow.answer(promptId, value) ? 'answered' : 'not_waiting';
    },

    cancelLogin(flowId) {
      const flow = flows.get(flowId);
      if (!flow) return undefined;
      flow.cancel();
      return flow.snapshot();
    },

    async logout(providerId) {
      const current = await runtime();
      const provider = findProvider(current, providerId);
      if (!provider) return { ok: false, code: 'unknown_provider', error: `Unknown provider: ${providerId}` };
      try {
        await current.logout(providerId, { signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS) });
      } catch (error) {
        return { ok: false, code: 'runtime', error: describe(error) };
      }
      notice(`signed out of ${provider.name}`);
      return { ok: true };
    },

    close() {
      for (const flow of flows.values()) flow.cancel();
      flows.clear();
    },
  };
}
