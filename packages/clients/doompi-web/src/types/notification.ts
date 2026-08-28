import {
  DOOM_NOTIFICATION_ENTRY_TYPE,
  type DoomNotificationEntryData,
  isDoomNotificationEntryData,
} from '@agimon-ai/doompi-extension-contracts/notification';

export interface DoomNotificationEntry {
  entryId: string;
  data: DoomNotificationEntryData;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads only a direct, validated Doom notification custom-entry frame. */
export function parseDoomNotificationEntry(frame: unknown): DoomNotificationEntry | undefined {
  if (!isRecord(frame) || frame.type !== 'entry_appended' || !isRecord(frame.entry)) return undefined;
  const entry = frame.entry;
  if (
    entry.type !== 'custom' ||
    entry.customType !== DOOM_NOTIFICATION_ENTRY_TYPE ||
    typeof entry.id !== 'string' ||
    entry.id.trim().length === 0 ||
    !isDoomNotificationEntryData(entry.data)
  ) {
    return undefined;
  }
  return { entryId: entry.id, data: entry.data };
}
