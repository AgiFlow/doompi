import { connectDoomCordisHost, finalizeDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const FINALIZER_SOURCE = '@agimon-ai/doompi/cordis-finalizer';

/** Last composed entry: joins every package cleanup, then ends the root. */
export async function cordisFinalizerExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, FINALIZER_SOURCE, { allowStandalone: false });
  let shutdown: Promise<void> | undefined;
  pi.on('session_shutdown', () => {
    shutdown ??= (async () => {
      await connection.dispose();
      await finalizeDoomCordisHost(pi, FINALIZER_SOURCE);
    })();
    return shutdown;
  });
}

export default cordisFinalizerExtension;
