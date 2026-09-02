import { sealedHttpSession } from '../../lib/sealedSession.ts';
import { fetchWithStepUp } from '../../lib/stepUp.ts';
import type { InstalledSettingsPanel } from '../../lib/pluginRegistry.ts';
import { SettingsSectionHeader } from './SettingsSectionHeader.tsx';

/**
 * The frame around a settings page a package draws itself.
 *
 * The host keeps the heading here rather than leaving it to the plugin, so a
 * self-drawn page carries the same label and detail the menu showed and the
 * reader does not have to trust each package to repeat them. Everything below
 * the heading belongs to the package.
 *
 * The transport is the host's for the same reason the repository panel's is:
 * only the host knows whether the page is being read over a tunnel, and a
 * plugin calling bare fetch would send plaintext to the relay.
 */

const requestThroughSealedSession = (input: string, init?: RequestInit): Promise<Response> =>
  sealedHttpSession.fetch(input, init);

interface SettingsPanelHostProps {
  panel: InstalledSettingsPanel;
}

export function SettingsPanelHost({ panel }: SettingsPanelHostProps) {
  const Panel = panel.component;
  return (
    <div className="flex flex-col gap-3" data-testid={`settings-panel-${panel.id}`}>
      <SettingsSectionHeader title={panel.label} detail={panel.detail} />
      <Panel request={requestThroughSealedSession} requestWithStepUp={fetchWithStepUp} />
    </div>
  );
}
