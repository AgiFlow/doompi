import { activateVerifiedBundle, activateVerifiedPluginComposition } from '../../pwa/workerClient';
import type { SessionWebComposition } from '../../types/hub';

let pin: { key: string; ready: Promise<void> } | undefined;

/** Development preserves Vite navigation while using the normal verified asset URLs. */
export async function verifiedDevComposition(composition: SessionWebComposition, publicKey: string) {
  if (pin?.key !== publicKey) {
    const ready = (async () => {
      await navigator.serviceWorker.register('/sw.js?development=1', { scope: '/' });
      const result = await activateVerifiedBundle({ publicKey, minimumRevision: 1 });
      if (!result.ok) throw new Error(`Development signing key refused: ${result.code}.`);
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve, reject) => {
          const changed = () => {
            if (!navigator.serviceWorker.controller) return;
            clearTimeout(timeout);
            navigator.serviceWorker.removeEventListener('controllerchange', changed);
            resolve();
          };
          const timeout = setTimeout(() => {
            navigator.serviceWorker.removeEventListener('controllerchange', changed);
            reject(new Error('The verification worker did not take control.'));
          }, 10_000);
          navigator.serviceWorker.addEventListener('controllerchange', changed);
          changed();
        });
      }
    })();
    pin = { key: publicKey, ready };
    void ready.catch(() => {
      if (pin?.ready === ready) pin = undefined;
    });
  }
  await pin.ready;
  const verified = await activateVerifiedPluginComposition(composition);
  if (!verified.ok) throw new Error(`Plugin composition refused: ${verified.code}.`);
  return { url: (assetPath: string) => `${composition.verifiedAssetBaseUrl}${assetPath}`, close: () => {} };
}
