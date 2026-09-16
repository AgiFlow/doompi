import type { DoomApi } from '@agimon-ai/doompi-core/package-api';

import { VOICE_API_BASE_PATH } from '../../constants/voice';
import { voiceReadiness } from '../../services/voiceReadiness';

export const voiceReadinessApi: DoomApi = {
  basePath: VOICE_API_BASE_PATH,
  start(context) {
    if (!context.homeDirectory) throw new Error('Voice readiness requires the configured server home.');
    const homeDirectory = context.homeDirectory;
    return {
      fetch(request) {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/readiness')
          return Response.json(voiceReadiness(context.workspaceRoot, homeDirectory, context.environment));
        return Response.json({ error: 'Not found.' }, { status: 404 });
      },
      close() {},
    };
  },
};
