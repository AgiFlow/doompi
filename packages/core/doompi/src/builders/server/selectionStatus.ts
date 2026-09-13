import type { DoomHeadlessSelection } from '@agimon-ai/doompi-core/headless';
import { domainStatus } from '@agimon-ai/doompi-domain';
import { statusText } from '@agimon-ai/doompi-major-mode';
export function publishHeadlessSelectionStatus(
  setStatus: (source: string, text: string | undefined) => void,
  selection: DoomHeadlessSelection,
): void {
  setStatus('doom-major-mode', statusText(selection.majorMode, selection.domains, selection.profile));
  setStatus('doom-domain', domainStatus(selection.domains));
  setStatus('doom-profile', selection.profile);
}
