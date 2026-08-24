import { surfaceContributions, type SurfaceSlot } from '../lib/pluginRegistry.ts';
import { useOpenTab } from '../stores/useOpenTab.ts';

/**
 * Renders every plugin contribution registered for one chrome slot. Host
 * surfaces place this where their layout wants plugin content; an empty slot
 * renders nothing. `except` names contributions the host already placed
 * somewhere more specific, so they do not render twice.
 */
export function PluginSurface({
  slot,
  sessionId,
  except,
}: {
  slot: SurfaceSlot;
  sessionId: string | null;
  except?: ReadonlySet<string>;
}) {
  const openTab = useOpenTab();
  return (
    <>
      {surfaceContributions(slot)
        .filter((entry) => !except?.has(entry.id))
        .map((entry) => (
          <entry.component key={entry.id} sessionId={sessionId} openTab={openTab} />
        ))}
    </>
  );
}
