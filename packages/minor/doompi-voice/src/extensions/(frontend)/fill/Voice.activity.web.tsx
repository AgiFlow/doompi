import { defineFill, type WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { useStore } from '@tanstack/react-store';

import { voiceMediaBrowserState } from '../../workspaces/sessions/(frontend)/_lib/voiceMediaWakeStore';
import { VoiceActivitySection } from '../../workspaces/sessions/(frontend)/fill/_components/VoiceActivitySection';

function GlobalLiveActivity(props: WebPluginSlotProps) {
  const media = useStore(voiceMediaBrowserState.store);
  if (props.sessionId !== null || media?.sessionId !== null || media.realtime?.connection === 'closed') return null;
  if (media.realtime === undefined) return null;
  return <VoiceActivitySection {...props} />;
}

export default defineFill({ slot: 'activity', id: 'voice-global-live', component: GlobalLiveActivity });
