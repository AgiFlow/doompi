import { join } from 'node:path';

import type { DoomApi } from '@agimon-ai/doompi-core/package-api';

import { VoiceClientSettingsStore, type VoiceAudioInput } from '../services/voiceClientSettings';
import { voiceReadiness } from '../services/voiceReadiness';

export const voiceClientSettingsApi: DoomApi = {
  basePath: 'voice',
  start(context) {
    if (!context.homeDirectory) throw new Error('Voice settings require the configured server home.');
    const store = new VoiceClientSettingsStore(join(context.homeDirectory, '.pi', '.doom', 'voice', 'clients.json'));
    return {
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/readiness')
          return Response.json(voiceReadiness(context.workspaceRoot, context.homeDirectory!, context.environment));
        const match = /^\/clients\/([a-zA-Z0-9_-]{1,200})(\/inputs)?$/.exec(url.pathname);
        if (!match) return Response.json({ error: 'Not found.' }, { status: 404 });
        const clientId = match[1]!;
        try {
          if (request.method === 'GET' && !match[2]) return Response.json(await store.read(clientId));
          if (request.method === 'DELETE' && !match[2]) return Response.json(await store.select(clientId, null));
          if (request.method !== 'PUT') return new Response(null, { status: 405 });
          const text = await request.text();
          if (text.length > 64_000) return Response.json({ error: 'Request is too large.' }, { status: 413 });
          const body: unknown = JSON.parse(text);
          if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Invalid settings.');
          if (match[2]) {
            const inputs = (body as { inputs?: unknown }).inputs;
            if (
              !Array.isArray(inputs) ||
              inputs.length > 100 ||
              inputs.some(
                (input) =>
                  typeof input !== 'object' ||
                  input === null ||
                  ['deviceId', 'groupId', 'label'].some(
                    (key) => typeof input[key] !== 'string' || input[key].length > 500,
                  ) ||
                  !input.deviceId ||
                  input.deviceId === 'default' ||
                  input.deviceId === 'communications',
              )
            )
              throw new Error('Invalid microphone list.');
            store.register(clientId, inputs as VoiceAudioInput[]);
            return Response.json(await store.read(clientId));
          }
          const deviceId = (body as { deviceId?: unknown }).deviceId;
          if (deviceId !== null && typeof deviceId !== 'string') throw new Error('Invalid microphone selection.');
          return Response.json(await store.select(clientId, deviceId));
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : 'Voice settings failed.' },
            { status: 400 },
          );
        }
      },
      close() {},
    };
  },
};
