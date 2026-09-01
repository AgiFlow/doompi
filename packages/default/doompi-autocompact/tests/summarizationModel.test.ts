import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadDoomConfig = vi.hoisted(() => vi.fn());
const harnessState = vi.hoisted(() => vi.fn(() => ({})));
vi.mock('@agimon-ai/doompi-config', () => ({ loadDoomConfig, getHarnessState: harnessState }));

const { autocompactRuntimeConfig, parseModelReference, resolveDoomSummarizationModel, resolveSummarizationModel } =
  await import('../src/adapters/pi/extension.ts');

type Model = NonNullable<ExtensionContext['model']>;

const SESSION_MODEL = { id: 'gpt-5.6-sol', provider: 'openai-codex' } as Model;
const SUBAGENT_MODEL = { id: 'gpt-5.6-luna', provider: 'openai-codex' } as Model;

function createContext(available: Model[] = [SUBAGENT_MODEL]): ExtensionContext {
  return {
    cwd: '/repo',
    model: SESSION_MODEL,
    thinkingLevel: 'low',
    modelRegistry: {
      find: (provider: string, modelId: string) =>
        available.find((model) => model.provider === provider && model.id === modelId),
    },
  } as unknown as ExtensionContext;
}

function configureSubagents(subagents: { model?: string; thinking?: string } | undefined): void {
  loadDoomConfig.mockReturnValue({ modes: { planning: { subagents } } });
}

describe('summarization model resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DOOMPI_ROOT;
    harnessState.mockReturnValue({});
  });

  it('splits provider, model, and the optional thinking suffix', () => {
    expect(parseModelReference('openai-codex/gpt-5.6-luna')).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.6-luna',
    });
    expect(parseModelReference(' openai-codex/gpt-5.6-luna:max ')).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.6-luna',
      thinking: 'max',
    });
    expect(parseModelReference('anthropic/claude/nested')).toEqual({
      provider: 'anthropic',
      modelId: 'claude/nested',
    });
    expect(parseModelReference('gpt-5.6-luna')).toBeUndefined();
    expect(parseModelReference('/gpt-5.6-luna')).toBeUndefined();
    expect(parseModelReference('openai-codex/')).toBeUndefined();
  });

  it('summarizes with the configured subagent model and thinking level', () => {
    configureSubagents({ model: 'openai-codex/gpt-5.6-luna', thinking: 'max' });

    expect(resolveDoomSummarizationModel(createContext())).toEqual({
      model: SUBAGENT_MODEL,
      thinkingLevel: 'max',
    });
  });

  it('reads the thinking level from a suffixed model reference', () => {
    configureSubagents({ model: 'openai-codex/gpt-5.6-luna:minimal' });

    expect(resolveDoomSummarizationModel(createContext())).toEqual({
      model: SUBAGENT_MODEL,
      thinkingLevel: 'minimal',
    });
  });

  it('applies a thinking level override to the session model when no model is configured', () => {
    configureSubagents({ thinking: 'max' });

    expect(resolveDoomSummarizationModel(createContext())).toEqual({
      model: SESSION_MODEL,
      thinkingLevel: 'max',
    });
  });

  it('falls back to the session model when the configured model is unavailable', () => {
    configureSubagents({ model: 'openai-codex/gpt-5.6-luna' });

    expect(resolveDoomSummarizationModel(createContext([]))).toEqual({
      model: SESSION_MODEL,
      thinkingLevel: 'low',
    });
  });

  it('falls back to the session model when the config is missing or unreadable', () => {
    configureSubagents(undefined);
    expect(resolveDoomSummarizationModel(createContext())).toEqual({
      model: SESSION_MODEL,
      thinkingLevel: 'low',
    });

    loadDoomConfig.mockImplementation(() => {
      throw new Error('malformed config');
    });
    expect(resolveDoomSummarizationModel(createContext())).toEqual({
      model: SESSION_MODEL,
      thinkingLevel: 'low',
    });
  });

  it('loads the active Pi model without consulting Doom config on the standard path', () => {
    expect(resolveSummarizationModel(createContext())).toEqual({ model: SESSION_MODEL, thinkingLevel: 'low' });
    expect(loadDoomConfig).not.toHaveBeenCalled();
  });

  it('prefers the autocompact keys over the planning subagent they used to borrow', () => {
    loadDoomConfig.mockReturnValue({
      modes: {
        planning: { subagents: { model: 'openai-codex/gpt-5.6-sol', thinking: 'low' } },
        autocompact: { model: 'openai-codex/gpt-5.6-luna', thinking: 'max' },
      },
    });

    expect(resolveDoomSummarizationModel(createContext())).toEqual({
      model: SUBAGENT_MODEL,
      thinkingLevel: 'max',
    });
  });

  it('reads the enable flag and the pass ratios, defaulting to on with no overrides', () => {
    loadDoomConfig.mockReturnValue({
      modes: { autocompact: { enabled: false, thresholds: { pass1: 0.4, pass3: 0.9 } } },
    });
    expect(autocompactRuntimeConfig('/repo')).toEqual({ enabled: false, ratios: { 1: 0.4, 3: 0.9 } });

    loadDoomConfig.mockReturnValue({ modes: {} });
    expect(autocompactRuntimeConfig('/repo')).toEqual({ enabled: true, ratios: {} });
  });
});
