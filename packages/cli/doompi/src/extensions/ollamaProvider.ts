import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function registerOllama(pi: ExtensionAPI): void {
  const modelArgument = process.argv.find((argument) => argument.startsWith('ollama/'));
  const model = modelArgument?.slice('ollama/'.length) ?? 'kimi-k2.6:cloud';
  pi.registerProvider('ollama', {
    name: 'Ollama',
    baseUrl: process.env.DOOMPI_OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
    apiKey: '$OLLAMA_API_KEY',
    api: 'openai-completions',
    models: [
      {
        id: model,
        name: model,
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262_144,
        maxTokens: 32_768,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
      },
    ],
  });
}
