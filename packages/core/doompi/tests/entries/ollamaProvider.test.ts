import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import registerOllama from '../../src/extensions/entries/ollamaProvider.ts';

interface RegisteredProvider {
  baseUrl: string;
  models: Array<{ id: string; name: string }>;
}

const originalArgv = process.argv;
const originalBaseUrl = process.env.DOOMPI_OLLAMA_BASE_URL;

function registerProvider(): ReturnType<typeof vi.fn<(name: string, provider: RegisteredProvider) => void>> {
  const register = vi.fn<(name: string, provider: RegisteredProvider) => void>();
  registerOllama({ registerProvider: register } as unknown as ExtensionAPI);
  return register;
}

describe('Ollama provider entry', () => {
  beforeEach(() => {
    process.argv = ['node', 'doompi'];
    delete process.env.DOOMPI_OLLAMA_BASE_URL;
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalBaseUrl === undefined) delete process.env.DOOMPI_OLLAMA_BASE_URL;
    else process.env.DOOMPI_OLLAMA_BASE_URL = originalBaseUrl;
  });

  it('registers the default hosted model and local endpoint', () => {
    const register = registerProvider();

    expect(register).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith(
      'ollama',
      expect.objectContaining({
        baseUrl: 'http://localhost:11434/v1',
        models: [expect.objectContaining({ id: 'kimi-k2.6:cloud', name: 'kimi-k2.6:cloud' })],
      }),
    );
  });

  it('uses the requested Ollama model and endpoint override', () => {
    process.argv.push('--model', 'ollama/qwen3:8b');
    process.env.DOOMPI_OLLAMA_BASE_URL = 'http://ollama.example/v1';

    const register = registerProvider();

    expect(register).toHaveBeenCalledWith(
      'ollama',
      expect.objectContaining({
        baseUrl: 'http://ollama.example/v1',
        models: [expect.objectContaining({ id: 'qwen3:8b', name: 'qwen3:8b' })],
      }),
    );
  });
});
