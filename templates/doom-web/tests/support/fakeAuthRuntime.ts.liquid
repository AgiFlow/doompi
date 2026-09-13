import type { AuthRuntime, AuthRuntimeProvider, LoginInteraction } from '../../src/types/auth.ts';

/**
 * A stand-in for Pi's ModelRuntime with three providers: one with both
 * methods, one ambient-only, and one OAuth-only. Its api-key login asks one
 * secret question and stores the answer; "bad" is refused.
 */
export interface FakeAuthRuntime extends AuthRuntime {
  stored: Set<string>;
  refreshes: number;
  logins: { providerId: string; type: string }[];
  logoutError?: Error;
}

const PROVIDERS: AuthRuntimeProvider[] = [
  {
    id: 'zeta',
    name: 'Zeta',
    auth: { oauth: { name: 'Zeta OAuth', loginLabel: 'Sign in with Zeta' } },
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    auth: {
      apiKey: { name: 'Anthropic API key', login: () => undefined },
      oauth: { name: 'Anthropic (Claude Pro/Max)' },
    },
  },
  { id: 'bedrock', name: 'Amazon Bedrock', auth: { apiKey: { name: 'AWS credentials' } } },
];

/** Two models per provider, so a grouped picker has something to group. */
const MODELS: readonly { provider: string; id: string }[] = [
  { provider: 'anthropic', id: 'claude-opus-4-8' },
  { provider: 'anthropic', id: 'claude-sonnet-5' },
  { provider: 'zeta', id: 'zeta-large' },
];

export function createFakeAuthRuntime(): FakeAuthRuntime {
  const runtime: FakeAuthRuntime = {
    stored: new Set(),
    refreshes: 0,
    logins: [],
    getProviders: () => PROVIDERS,
    getProviderAuthStatus(providerId) {
      if (runtime.stored.has(providerId)) return { configured: true, source: 'stored' };
      if (providerId === 'bedrock') return { configured: true, source: 'environment', label: 'AWS_PROFILE' };
      return { configured: false };
    },
    isUsingOAuth: (providerId) => providerId === 'zeta' && runtime.stored.has(providerId),
    getAvailableSnapshot: () => MODELS,
    hasConfiguredAuth: (providerId) => runtime.getProviderAuthStatus(providerId).configured,
    async refresh() {
      runtime.refreshes += 1;
    },
    async login(providerId, type, interaction: LoginInteraction) {
      runtime.logins.push({ providerId, type });
      interaction.signal.throwIfAborted();
      if (type === 'oauth') {
        interaction.notify({ type: 'auth_url', url: `https://${providerId}.example/authorize` });
        const code = await interaction.prompt({ type: 'manual_code', message: 'Paste the code' });
        interaction.notify({ type: 'progress', message: `exchanging ${code}` });
      } else {
        const key = await interaction.prompt({ type: 'secret', message: `Enter ${providerId} key` });
        if (key === 'bad') throw new Error('The key was refused.');
      }
      runtime.stored.add(providerId);
      return { type };
    },
    async logout(providerId) {
      if (runtime.logoutError) throw runtime.logoutError;
      runtime.stored.delete(providerId);
    },
  };
  return runtime;
}

/** Lets a queued promise settle. */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
