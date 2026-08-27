import { Spinner } from '@agimon-ai/doompi-web-components';

/**
 * What the page shows while its own hub is being replaced.
 *
 * There is nothing to ask the server during a handover, because the server is
 * the thing moving. The socket reconnects on its own once the container is
 * serving, and that reconnection is what ends this panel, so the copy says to
 * wait rather than offering a button that would fail.
 */
export function HandoverProgress() {
  return (
    <div className="flex flex-col gap-3" data-testid="remote-handover">
      <div className="flex items-center gap-2 text-xs text-doom-hi">
        <Spinner />
        Moving the cockpit into a container.
      </div>
      <p className="text-[11px] leading-relaxed text-doom-faint">
        This page reconnects on its own when the container is serving, and the code to scan appears then. The first run
        for a new version builds the image, which can take several minutes. Progress is printed in the terminal that
        started the cockpit.
      </p>
    </div>
  );
}
