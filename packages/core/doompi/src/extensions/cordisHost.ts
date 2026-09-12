import { installDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const HOST_SOURCE = '@agimon-ai/doompi/cordis-host';

/** First composed entry: owns the single Cordis application root. */
export async function cordisHostExtension(pi: ExtensionAPI): Promise<void> {
  await installDoomCordisHost(pi, { mode: 'composed', source: HOST_SOURCE });
}

export default cordisHostExtension;
