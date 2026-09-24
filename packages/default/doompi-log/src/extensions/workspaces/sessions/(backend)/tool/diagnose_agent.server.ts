import { defineTool } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { PACKAGE_NAME } from '../../../../../constants/telemetry';
import { createAgentDiagnosticsTool } from '../../../../../services/agentDiagnostics';

export default defineTool(({ agent, signal: ownerSignal }: DoomServerPluginContext) => {
  if (!agent) throw new Error('Agent diagnostics require a session host.');
  return createAgentDiagnosticsTool(
    () => ({
      sessionId: agent.context.sessionId,
      options: {
        cwd: agent.context.cwd,
        env: { ...agent.context.environment, PI_SESSION_ID: agent.context.sessionId },
      },
    }),
    (signal) => {
      ownerSignal.throwIfAborted();
      signal?.throwIfAborted();
      agent.assertActive(PACKAGE_NAME);
      if (!(agent.context.selection.state?.['minor-mode'] ?? []).includes('help'))
        throw new Error('Help mode is not active.');
      return signal ? AbortSignal.any([signal, ownerSignal]) : ownerSignal;
    },
  );
});
