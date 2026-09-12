import { describe, expect, it } from 'vitest';
import { applyModelGuidance, guidanceForModel, mergeModelGuidance } from '../../../src/services/modelGuidance';
import type { ModelGuidanceDocument } from '../../../src/types/modelGuidance';

const global: ModelGuidanceDocument = {
  modelGuidance: { 'claude-opus-5': 'Stay focused.', 'gpt-6-astra': 'Batch tools.' },
};
const repository: ModelGuidanceDocument = {
  modelGuidance: { 'claude-opus-5': 'Cordis rules apply.', 'local-qwen-3': 'Short answers only.' },
};

describe('mergeModelGuidance', () => {
  it('returns an empty map for no documents', () => {
    expect(mergeModelGuidance([])).toEqual({});
  });

  it('passes a single document through', () => {
    expect(mergeModelGuidance([global])).toEqual({
      'claude-opus-5': 'Stay focused.',
      'gpt-6-astra': 'Batch tools.',
    });
  });

  it('lets a later document win one model id while earlier ids survive', () => {
    expect(mergeModelGuidance([global, repository])).toEqual({
      'claude-opus-5': 'Cordis rules apply.',
      'gpt-6-astra': 'Batch tools.',
      'local-qwen-3': 'Short answers only.',
    });
  });

  it('ignores a document without the modelGuidance key', () => {
    expect(mergeModelGuidance([{}])).toEqual({});
  });

  it('drops whitespace-only guidance rather than storing an empty string', () => {
    expect(mergeModelGuidance([{ modelGuidance: { 'claude-opus-5': '   \n  ' } }])).toEqual({});
  });

  it('trims surrounding whitespace from a block scalar', () => {
    expect(mergeModelGuidance([{ modelGuidance: { 'claude-opus-5': '\nStay focused.\n' } }])).toEqual({
      'claude-opus-5': 'Stay focused.',
    });
  });

  it('skips non-string values without throwing and keeps the valid siblings', () => {
    const document = { modelGuidance: { bad: 42, nested: { a: 1 }, good: 'Keep it.' } } as ModelGuidanceDocument;
    expect(mergeModelGuidance([document])).toEqual({ good: 'Keep it.' });
  });

  it('does not let an earlier whitespace-only entry erase a later real one', () => {
    const documents = [{ modelGuidance: { m: '  ' } }, { modelGuidance: { m: 'Real.' } }];
    expect(mergeModelGuidance(documents)).toEqual({ m: 'Real.' });
  });
});

describe('guidanceForModel', () => {
  const map = mergeModelGuidance([global]);

  it('returns the guidance for an exact match', () => {
    expect(guidanceForModel(map, 'gpt-6-astra')).toBe('Batch tools.');
  });

  it('returns undefined for an unknown model id', () => {
    expect(guidanceForModel(map, 'claude-opus-4')).toBeUndefined();
  });

  it('returns undefined when the model id is undefined', () => {
    expect(guidanceForModel(map, undefined)).toBeUndefined();
  });

  it('does not match on prefix, because matching is exact', () => {
    expect(guidanceForModel(map, 'gpt-6-astra-20260101')).toBeUndefined();
  });
});

describe('applyModelGuidance', () => {
  it('returns undefined when there is no guidance, leaving the prompt untouched', () => {
    expect(applyModelGuidance('base', undefined)).toBeUndefined();
  });

  it('re-embeds the incoming prompt so earlier contributions survive', () => {
    const result = applyModelGuidance('EARLIER_CONTRIBUTION', 'Stay focused.');
    expect(result).toContain('EARLIER_CONTRIBUTION');
    expect(result).toBe('EARLIER_CONTRIBUTION\n\nStay focused.');
  });
});
