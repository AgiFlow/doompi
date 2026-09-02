import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteSavedPrompt, fetchSavedPrompts, saveSavedPrompt } from '../../src/web/promptsApi.ts';

vi.mock('@agimon-ai/doompi-web-security/browser', () => ({ sealedTransport: { fetch: vi.fn() } }));

const transport = vi.mocked(sealedTransport.fetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  transport.mockReset();
});

describe('reading the library', () => {
  it('returns the prompts the hub reports', async () => {
    transport.mockResolvedValue(jsonResponse({ prompts: [{ name: 'review', description: 'r', text: 'r' }] }));

    await expect(fetchSavedPrompts()).resolves.toEqual({
      prompts: [{ name: 'review', description: 'r', text: 'r' }],
    });
    expect(transport).toHaveBeenCalledWith('/api/plugin/prompts/prompts', {});
  });

  it('passes the abort signal through', async () => {
    const controller = new AbortController();
    transport.mockResolvedValue(jsonResponse({ prompts: [] }));

    await fetchSavedPrompts(controller.signal);

    expect(transport).toHaveBeenCalledWith('/api/plugin/prompts/prompts', { signal: controller.signal });
  });

  it('treats an abort as no answer rather than a failure to show', async () => {
    transport.mockRejectedValue(new DOMException('aborted', 'AbortError'));

    await expect(fetchSavedPrompts()).resolves.toEqual({ error: '' });
  });

  it('reports an unreachable hub', async () => {
    transport.mockRejectedValue(new TypeError('network down'));

    await expect(fetchSavedPrompts()).resolves.toEqual({ error: 'The hub did not answer.' });
  });

  it('surfaces the message the hub sent with a refusal', async () => {
    transport.mockResolvedValue(jsonResponse({ error: 'permission denied' }, 500));

    await expect(fetchSavedPrompts()).resolves.toEqual({ error: 'permission denied' });
  });

  it('falls back to the status when the refusal carries no message', async () => {
    transport.mockResolvedValue(new Response('<html>', { status: 502 }));

    await expect(fetchSavedPrompts()).resolves.toEqual({ error: 'The hub answered 502.' });
  });

  it('reports a malformed list', async () => {
    transport.mockResolvedValue(new Response('not json', { status: 200 }));

    await expect(fetchSavedPrompts()).resolves.toEqual({ error: 'The hub sent a malformed prompt list.' });
  });

  it('tolerates a list body without the prompts key', async () => {
    transport.mockResolvedValue(jsonResponse({}));

    await expect(fetchSavedPrompts()).resolves.toEqual({ prompts: [] });
  });
});

describe('writing the library', () => {
  it('puts the prompt text under its name', async () => {
    transport.mockResolvedValue(jsonResponse({ prompt: {}, replaced: false }));

    await expect(saveSavedPrompt('review', 'body')).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledWith('/api/plugin/prompts/prompts/review', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'body' }),
    });
  });

  it('reports a refused write', async () => {
    transport.mockResolvedValue(jsonResponse({ error: 'not a usable prompt name' }, 400));

    await expect(saveSavedPrompt('Bad', 'body')).resolves.toEqual({ error: 'not a usable prompt name' });
  });

  it('reports an unreachable hub on write', async () => {
    transport.mockRejectedValue(new TypeError('network down'));

    await expect(saveSavedPrompt('review', 'body')).resolves.toEqual({ error: 'The hub did not answer.' });
  });

  it('deletes by name', async () => {
    transport.mockResolvedValue(jsonResponse({ name: 'review' }));

    await expect(deleteSavedPrompt('review')).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledWith('/api/plugin/prompts/prompts/review', { method: 'DELETE' });
  });

  it('reports a refused delete', async () => {
    transport.mockResolvedValue(jsonResponse({ error: 'No saved prompt is named "gone".' }, 404));

    await expect(deleteSavedPrompt('gone')).resolves.toEqual({ error: 'No saved prompt is named "gone".' });
  });

  it('reports an unreachable hub on delete', async () => {
    transport.mockRejectedValue(new TypeError('network down'));

    await expect(deleteSavedPrompt('review')).resolves.toEqual({ error: 'The hub did not answer.' });
  });

  it('escapes a name that would otherwise change the path', async () => {
    transport.mockResolvedValue(jsonResponse({ name: 'x' }));

    await deleteSavedPrompt('a/b');

    expect(transport).toHaveBeenCalledWith('/api/plugin/prompts/prompts/a%2Fb', { method: 'DELETE' });
  });
});
