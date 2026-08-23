export interface BrokerRoute {
  /** Pi provider name, which is also the broker's first path segment. */
  provider: string;
  /** Upstream origin plus any base path Pi's own provider data carries. */
  upstream: string;
  /** Host environment variables that may hold the real credential, in priority order. */
  hostKeyEnv: readonly string[];
}

/**
 * Providers the broker can terminate, mirroring Pi's own provider data.
 *
 * Curated rather than derived: Pi keeps base URLs in package-internal JSON that
 * carries no stability promise. A provider missing here is simply not brokered,
 * and its credential stays on the host.
 */
const ROUTES: readonly BrokerRoute[] = [
  { provider: 'anthropic', upstream: 'https://api.anthropic.com', hostKeyEnv: ['ANTHROPIC_API_KEY'] },
  { provider: 'openai', upstream: 'https://api.openai.com/v1', hostKeyEnv: ['OPENAI_API_KEY'] },
  { provider: 'google', upstream: 'https://generativelanguage.googleapis.com/v1beta', hostKeyEnv: ['GEMINI_API_KEY'] },
  { provider: 'groq', upstream: 'https://api.groq.com/openai/v1', hostKeyEnv: ['GROQ_API_KEY'] },
  { provider: 'xai', upstream: 'https://api.x.ai/v1', hostKeyEnv: ['XAI_API_KEY'] },
  { provider: 'openrouter', upstream: 'https://openrouter.ai/api/v1', hostKeyEnv: ['OPENROUTER_API_KEY'] },
  { provider: 'deepseek', upstream: 'https://api.deepseek.com', hostKeyEnv: ['DEEPSEEK_API_KEY'] },
  { provider: 'mistral', upstream: 'https://api.mistral.ai', hostKeyEnv: ['MISTRAL_API_KEY'] },
  { provider: 'together', upstream: 'https://api.together.ai/v1', hostKeyEnv: ['TOGETHER_API_KEY'] },
  { provider: 'cerebras', upstream: 'https://api.cerebras.ai/v1', hostKeyEnv: ['CEREBRAS_API_KEY'] },
  { provider: 'moonshotai', upstream: 'https://api.moonshot.ai/v1', hostKeyEnv: ['MOONSHOT_API_KEY'] },
  { provider: 'zai', upstream: 'https://api.z.ai/api/coding/paas/v4', hostKeyEnv: ['ZAI_API_KEY'] },
];

export function brokerRoutes(): readonly BrokerRoute[] {
  return ROUTES;
}

export function findBrokerRoute(provider: string): BrokerRoute | undefined {
  return ROUTES.find((route) => route.provider === provider);
}

export interface ResolvedCredential {
  route: BrokerRoute;
  /** Environment variable the container would otherwise have received. */
  envName: string;
  value: string;
}

/** Selects the providers this host can actually broker for a session. */
export function resolveBrokeredCredentials(
  environment: Readonly<Record<string, string | undefined>>,
): ResolvedCredential[] {
  const resolved: ResolvedCredential[] = [];
  for (const route of ROUTES) {
    for (const envName of route.hostKeyEnv) {
      const value = environment[envName]?.trim();
      if (value) {
        resolved.push({ route, envName, value });
        break;
      }
    }
  }
  return resolved;
}
