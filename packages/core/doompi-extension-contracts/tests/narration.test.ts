import { Context } from '@deepseek-ai/cordis';
import { Check } from 'typebox/value';
import { describe, expect, it, vi } from 'vitest';
import {
  createNarrationRequest,
  DOOM_NARRATION_SERVICE,
  type DoomNarrationService,
  MAX_NARRATION_TEXT_CHARACTERS,
  NarrationRequestSchema,
  normalizeNarrationText,
  readDoomNarrationService,
  requireDoomNarrationService,
} from '../src/schemas/narration.ts';

describe('Doom narration Cordis contract', () => {
  it('normalizes whitespace and control characters into a validated request', () => {
    const request = createNarrationRequest('  Ready\n\tto speak.  ');
    expect(request).toEqual({ text: 'Ready to speak.' });
    expect(Check(NarrationRequestSchema, request)).toBe(true);
    expect(createNarrationRequest('\u0000\u007f')).toBeUndefined();
  });

  it('truncates without splitting Unicode characters', () => {
    const text = normalizeNarrationText('🙂'.repeat(MAX_NARRATION_TEXT_CHARACTERS));
    expect(text).toHaveLength(MAX_NARRATION_TEXT_CHARACTERS);
    expect(text?.endsWith('🙂')).toBe(true);
  });

  it('discovers the request service only while its provider fiber is live', async () => {
    const root = new Context();
    const request = vi.fn();
    const service: DoomNarrationService = { generation: 'narration-generation', request };
    const fiber = root.plugin((context) => context.provide(DOOM_NARRATION_SERVICE, service));
    await fiber.await();

    const narration = requireDoomNarrationService(root);
    const payload = createNarrationRequest('Task list created.');
    expect(payload).toBeDefined();
    if (payload) await narration.request(payload);
    expect(request).toHaveBeenCalledWith({ text: 'Task list created.' });
    expect(readDoomNarrationService(root)).toBe(service);

    await fiber.dispose();
    expect(readDoomNarrationService(root)).toBeUndefined();
    await root.fiber.dispose();
  });
});
