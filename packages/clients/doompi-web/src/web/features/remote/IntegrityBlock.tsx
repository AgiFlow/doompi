import { Button } from '@agimon-ai/doompi-web-components';
import { useEffect, useState } from 'react';
import { forgetBundleKey, verifyBundle, type IntegrityVerdict } from '../../lib/bundleIntegrity.ts';

/**
 * Blocks the cockpit when the page was not signed by the hub this device paired
 * with.
 *
 * A full-screen stop rather than a banner, because the failure mode this covers
 * is a substituted bundle: if the page is not the page this hub built, nothing
 * rendered underneath can be trusted, including a dismiss button.
 *
 * A verification that could not run is not a failure. `unavailable` renders
 * nothing, so a browser without WebCrypto or with storage denied still works,
 * just without this check.
 */
export function IntegrityBlock() {
  const [verdict, setVerdict] = useState<IntegrityVerdict | undefined>();

  useEffect(() => {
    let cancelled = false;
    void verifyBundle().then((next) => {
      if (!cancelled) setVerdict(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (verdict?.state !== 'tampered') return null;

  return (
    <div
      role="alertdialog"
      data-testid="integrity-block"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-doom-deep p-6"
    >
      <div className="flex max-w-md flex-col gap-3 rounded-lg border border-doom-edge-red bg-doom-tint-red p-5">
        <h1 className="text-sm font-bold text-doom-red">This cockpit could not be verified</h1>
        <p className="text-xs leading-relaxed text-doom-hi">{verdict.reason}</p>
        <p className="text-xs leading-relaxed text-doom-dim">
          Do not enter anything here. Close this page and pair again from the machine itself. If it keeps happening, the
          tunnel in front of this cockpit is serving something the hub did not build.
        </p>
        <Button
          variant="danger-outline"
          size="sm"
          data-testid="integrity-reset"
          onClick={() => {
            // Only for the legitimate case: the hub's key really did change,
            // for instance after its state directory was cleared.
            forgetBundleKey();
            window.location.reload();
          }}
        >
          I re-created this hub, trust the new key
        </Button>
      </div>
    </div>
  );
}
