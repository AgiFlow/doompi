import type { ProtocolEvent, SessionPresentation } from '@agimon-ai/doompi-extension-contracts/session-protocol';

const MAX_EVENTS = 1024;
const MAX_BYTES = 8 * 1024 * 1024;

/** Retain current UI projections independently of the bounded live-event history. */
export function createSessionPresentation() {
  let revision = 0;
  let dropped = 0;
  let resetRevision = 0;
  let bytes = 0;
  const events: Array<{ event: ProtocolEvent; size: number }> = [];
  const projections = new Map<string, { event: ProtocolEvent; size: number }>();
  let projectedBytes = 0;
  const removeProjection = (key: string) => {
    projectedBytes -= projections.get(key)?.size ?? 0;
    projections.delete(key);
  };
  const snapshot = (): SessionPresentation => ({
    revision,
    dropped,
    resetRevision,
    events: events.map((item) => item.event),
    projections: [...projections.values()].map((item) => item.event),
  });
  return {
    resetCustomEntries(): SessionPresentation {
      // A tree replacement must not replay custom projections from the abandoned branch.
      events.length = 0;
      bytes = 0;
      for (const key of projections.keys()) if (key.startsWith('custom:')) removeProjection(key);
      resetRevision = ++revision;
      return snapshot();
    },
    record(raw: Record<string, unknown>): SessionPresentation | undefined {
      if (
        typeof raw.type !== 'string' ||
        raw.type === 'message_update' ||
        // Queries have typed replies. Do not replay raw history or model configuration.
        (raw.type === 'response' &&
          ['get_entries', 'get_messages', 'get_available_models'].includes(String(raw.command)))
      )
        return undefined;
      const encoded = JSON.stringify(raw);
      const frame: ProtocolEvent['frame'] = JSON.parse(encoded);
      const event = { sequence: ++revision, frame };
      let key: string | undefined;
      if (frame.type === 'extension_ui_request') {
        if (frame.method === 'setStatus' && typeof frame.statusKey === 'string') key = `status:${frame.statusKey}`;
        else if (frame.method === 'setWidget' && typeof frame.widgetKey === 'string') key = `widget:${frame.widgetKey}`;
        else if (
          typeof frame.id === 'string' &&
          typeof frame.method === 'string' &&
          ['select', 'confirm', 'input', 'editor'].includes(frame.method)
        )
          key = `dialog:${frame.id}`;
      }
      if (frame.type === 'extension_ui_answered' && typeof frame.id === 'string')
        removeProjection(`dialog:${frame.id}`);
      const entry = frame.entry;
      if (
        frame.type === 'entry_appended' &&
        entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        entry.type === 'custom' &&
        typeof entry.customType === 'string'
      )
        key = `custom:${entry.customType}`;
      const size = Buffer.byteLength(encoded);
      if (key) {
        removeProjection(key);
        projections.set(key, { event, size });
        projectedBytes += size;
        while (projections.size > MAX_EVENTS || projectedBytes > MAX_BYTES) {
          const oldest = projections.keys().next().value;
          if (oldest === undefined) break;
          removeProjection(oldest);
          dropped += 1;
        }
      }
      events.push({ event, size });
      bytes += size;
      while (events.length > MAX_EVENTS || bytes > MAX_BYTES) {
        const removed = events.shift();
        if (removed) {
          bytes -= removed.size;
          dropped += 1;
        }
      }
      return snapshot();
    },
  };
}
