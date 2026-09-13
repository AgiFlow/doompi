import path from 'node:path';

import { DOOM_CHILD_SESSION_SERVICE } from '@agimon-ai/doompi-core/child';
import {
  connectDoomCordisHost,
  DOOM_CORDIS_SESSION_SERVICE,
  type DoomCordisSessionService,
} from '@agimon-ai/doompi-core/cordis-host';
import { createTerminalPiChildSessionServiceProvider } from '@agimon-ai/doompi-core/terminal-pi-child-session-service';
import type { Context } from '@deepseek-ai/cordis';
import { getAgentDir, ModelRuntime, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

const PACKAGE_SOURCE = '@agimon-ai/doompi/terminal-child-session';

function terminalChildSessionPlugin(cordis: Context, models: ModelRuntime, sessionsRoot: string): void {
  cordis.inject([DOOM_CORDIS_SESSION_SERVICE], (sessionContext) => {
    const session = sessionContext.get(DOOM_CORDIS_SESSION_SERVICE) as DoomCordisSessionService;
    const extensionContext = session.context;
    const childSessions = createTerminalPiChildSessionServiceProvider({
      cwd: extensionContext.cwd,
      sessionsRoot,
      models,
      defaultModel: () => extensionContext.model,
    });
    sessionContext.provide(DOOM_CHILD_SESSION_SERVICE, childSessions.get());
    sessionContext.effect(() => () => childSessions.close(), `${PACKAGE_SOURCE}/lifetime`);
  });
}

/** Bind terminal Pi child ownership inside the core Cordis composition, before feature packages consume it. */
export async function terminalChildSessionExtension(pi: ExtensionAPI): Promise<void> {
  const agentDir = getAgentDir();
  const models = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const sessionsRoot = path.join(agentDir, 'sessions');
  const fiber = connection.root.plugin((cordis) => terminalChildSessionPlugin(cordis, models, sessionsRoot));
  let disposal: Promise<void> | undefined;
  pi.on(
    'session_shutdown',
    () =>
      (disposal ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })()),
  );
  try {
    await fiber;
  } catch (error) {
    await fiber.dispose();
    await connection.dispose();
    throw error;
  }
}

export default terminalChildSessionExtension;
