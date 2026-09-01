import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateSummary = vi.hoisted(() => vi.fn(async () => 'checkpoint'));
vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-coding-agent')>()),
  generateSummary,
}));

const { autocompactExtension, generateCheckpointWithPi, installAutocompactRuntime } =
  await import('../src/adapters/pi/extension.ts');
const standardPiExtension = (await import('../src/exports/extensions/pi.ts')).default;

const adapterPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/exports/extensions/pi.ts');

type SummarizationModel = NonNullable<ExtensionContext['model']>;

const MODEL = { id: 'claude-opus-5', provider: 'anthropic-vertex', api: 'anthropic-vertex' } as SummarizationModel;

/**
 * A provider registered by a Pi extension only exists in the session's own
 * registry, so the checkpoint context carries the provider rather than the
 * credentials alone.
 */
function createContext(provider: unknown, auth: unknown = { ok: true, apiKey: 'key', headers: { 'x-doom': 'v' } }) {
  return {
    cwd: '/repo',
    modelRegistry: {
      getApiKeyAndHeaders: async () => auth,
      getProvider: (id: string) => (id === MODEL.provider ? provider : undefined),
    },
  } as unknown as ExtensionContext;
}

function checkpointInput(context: ExtensionContext, signal: AbortSignal) {
  return {
    messages: [],
    instructions: 'checkpoint instructions',
    previousCheckpoint: 'previous checkpoint',
    context,
    signal,
  } as unknown as Parameters<typeof generateCheckpointWithPi>[0];
}

describe('Doom Autocompact Pi adapter boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateSummary.mockResolvedValue('checkpoint');
  });

  it('exposes one thin standard Pi factory over the package-local runtime installer', () => {
    expect(standardPiExtension).toBe(autocompactExtension);
    expect(standardPiExtension).not.toBe(installAutocompactRuntime);

    const source = fs.readFileSync(adapterPath, 'utf8');
    expect(source).toContain('autocompactExtension as default');
    expect(source).not.toMatch(/session_start|session_shutdown|registerDoom/u);
  });

  it('summarizes through the provider the session resolved for the model', async () => {
    const streamSimple = vi.fn(() => 'stream');
    const controller = new AbortController();
    const context = createContext({ id: MODEL.provider, streamSimple });

    await expect(
      generateCheckpointWithPi(checkpointInput(context, controller.signal), () => ({
        model: MODEL,
        thinkingLevel: 'low',
      })),
    ).resolves.toBe('checkpoint');

    const call = generateSummary.mock.calls[0] as unknown as unknown[];
    expect(call[1]).toBe(MODEL);
    expect(call[3]).toBe('key');
    expect(call[4]).toEqual({ 'x-doom': 'v' });
    expect(call[5]).toBe(controller.signal);
    expect(call[6]).toBe('checkpoint instructions');
    expect(call[7]).toBe('previous checkpoint');
    expect(call[8]).toBe('low');

    const streamFn = call[9] as (model: unknown, context: unknown, options: unknown) => unknown;
    expect(streamFn(MODEL, 'context', 'options')).toBe('stream');
    expect(streamSimple).toHaveBeenCalledWith(MODEL, 'context', 'options');
  });

  it('fails with the provider name when the session has no provider for the model', async () => {
    const context = createContext(undefined);

    await expect(
      generateCheckpointWithPi(checkpointInput(context, new AbortController().signal), () => ({ model: MODEL })),
    ).rejects.toThrow('No provider is registered for "anthropic-vertex" in this session.');
    expect(generateSummary).not.toHaveBeenCalled();
  });

  it('fails before the request when provider authentication is unresolved', async () => {
    const context = createContext({ id: MODEL.provider, streamSimple: vi.fn() }, { ok: false, error: 'No API key' });

    await expect(
      generateCheckpointWithPi(checkpointInput(context, new AbortController().signal), () => ({ model: MODEL })),
    ).rejects.toThrow('No API key');
    expect(generateSummary).not.toHaveBeenCalled();
  });

  it('fails when no model is available for summarization', async () => {
    const context = createContext({ id: MODEL.provider, streamSimple: vi.fn() });

    await expect(
      generateCheckpointWithPi(checkpointInput(context, new AbortController().signal), () => undefined),
    ).rejects.toThrow('No active model is available for autocompact summarization.');
    expect(generateSummary).not.toHaveBeenCalled();
  });
});
