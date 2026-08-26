/**
 * Wire vocabulary for provider authentication, shared by the hub routes and
 * the settings page.
 *
 * The hub keeps one Pi ModelRuntime over the same auth.json the sessions
 * read, so a login here is a login for every session on this machine. Prompt
 * and event shapes restate pi-ai's AuthPrompt and AuthEvent so neither the
 * flow service nor the page needs a pi import; the abort signal never leaves
 * the hub.
 */

/** REST endpoint listing providers with their auth state; DELETE /:providerId signs out. */
export const AUTH_PROVIDERS_API_ROUTE = '/api/auth/providers';
/** REST endpoint for login flows: POST starts one, GET /:flowId polls it, POST /:flowId/answer answers its prompt, DELETE /:flowId cancels. */
export const AUTH_LOGINS_API_ROUTE = '/api/auth/logins';

export type AuthMethodType = 'api_key' | 'oauth';

export interface ProviderAuthMethod {
  type: AuthMethodType;
  /** What the provider calls this method: "Anthropic API key", "Anthropic (Claude Pro/Max)". */
  label: string;
}

export interface ProviderAuthSummary {
  id: string;
  name: string;
  /** Login methods the provider offers; ambient-only providers list none. */
  methods: ProviderAuthMethod[];
  /**
   * Present once the provider has working auth: how, and where the credential
   * comes from ("stored", or the environment variable that holds the key).
   */
  authenticated?: { type: AuthMethodType; source?: string };
}

export interface LoginSelectOption {
  id: string;
  label: string;
  description?: string;
}

/** pi-ai's AuthPrompt, restated. `signal` cancels this one question, not the flow. */
export type LoginPrompt = { signal?: AbortSignal } & (
  | { type: 'text'; message: string; placeholder?: string }
  | { type: 'secret'; message: string; placeholder?: string }
  | { type: 'select'; message: string; options: readonly LoginSelectOption[] }
  | { type: 'manual_code'; message: string; placeholder?: string }
);

/** The question the page answers: a prompt with an id and without its signal. */
export interface LoginPromptView {
  id: string;
  type: LoginPrompt['type'];
  message: string;
  placeholder?: string;
  /** Present for select prompts. */
  options?: LoginSelectOption[];
}

/** pi-ai's AuthEvent, restated. */
export type LoginEvent =
  | { type: 'info'; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | {
      type: 'device_code';
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: 'progress'; message: string };

export type LoginFlowStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface LoginFlowSnapshot {
  id: string;
  providerId: string;
  providerName: string;
  type: AuthMethodType;
  status: LoginFlowStatus;
  events: LoginEvent[];
  /** The question the flow is waiting on, while there is one. */
  prompt?: LoginPromptView;
  /** Why the flow failed, once it has. */
  error?: string;
}

/** pi-ai's AuthInteraction: what a provider's login needs from its host. */
export interface LoginInteraction {
  signal: AbortSignal;
  prompt(prompt: LoginPrompt): Promise<string>;
  notify(event: LoginEvent): void;
}

export interface AuthRuntimeProvider {
  readonly id: string;
  readonly name: string;
  readonly auth: {
    /** Absent `login` means ambient-only (env vars, AWS profiles): nothing to sign in to. */
    apiKey?: { name: string; login?: unknown };
    oauth?: { name: string; loginLabel?: string };
  };
}

/**
 * The slice of Pi's ModelRuntime the hub relies on, so a test can stand in a
 * fake and the adapter never types against the whole agent.
 */
export interface AuthRuntime {
  getProviders(): readonly AuthRuntimeProvider[];
  getProviderAuthStatus(providerId: string): { configured: boolean; source?: string; label?: string };
  isUsingOAuth(providerId: string): boolean;
  /** Re-reads models.json and every provider's auth state without touching the network. */
  refresh(options: { allowNetwork: boolean }): Promise<unknown>;
  login(providerId: string, type: AuthMethodType, interaction: LoginInteraction): Promise<unknown>;
  logout(providerId: string, options?: { signal?: AbortSignal }): Promise<void>;
}
