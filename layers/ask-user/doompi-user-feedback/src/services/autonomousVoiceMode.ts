import type { MinorModeRecord } from '@agimon-ai/doompi-extension-contracts/mode';
import { DOOM_VOICE_AUTO_MODE_ID, DOOM_VOICE_SOURCE } from '@agimon-ai/doompi-extension-contracts/narration';

/**
 * Matches only the Voice package's own autonomous mode, and only while it reports active.
 *
 * Both the source and the mode id are checked because another package may register a mode
 * under the same id, and a transitional `activating` or `deactivating` record is not yet
 * (or no longer) speaking.
 */
export function isAutonomousVoiceRecord(record: MinorModeRecord): boolean {
  return (
    record.descriptor.source === DOOM_VOICE_SOURCE &&
    record.descriptor.id === DOOM_VOICE_AUTO_MODE_ID &&
    record.state.activation === 'active'
  );
}

export function isAutonomousVoiceActive(records: readonly MinorModeRecord[]): boolean {
  return records.some((record) => isAutonomousVoiceRecord(record));
}
