/*
 * Plain CSF objects: the style-system renderer parses this file statically and
 * mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 *
 * The variants are the raw `doom-voice` status lines the session publishes,
 * parsed by the component's own reader. The conflict row is the one state that
 * is not in a status: it comes from the page-wide media store, which is keyed
 * by session id, so only that variant's session sees it.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';

import { voiceMediaBrowserState } from '../stores/voiceMediaWakeStore';
import { VoiceActivitySection } from './VoiceActivitySection';

const CONFLICT_SESSION = 'voice-conflict';
voiceMediaBrowserState.update(() => ({ sessionId: CONFLICT_SESSION, phase: 'conflict' }));

const slot = (status?: string, sessionId: string | null = 's1') =>
  slotPropsFixture({ sessionId, statuses: status === undefined ? {} : { 'doom-voice': status } }).props;

const meta = {
  title: 'Voice/VoiceActivitySection',
  component: VoiceActivitySection,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">idle</span>
        <VoiceActivitySection {...slot()} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">auto · listening</span>
        <VoiceActivitySection {...slot('voice auto: listening')} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">auto · composing</span>
        <VoiceActivitySection {...slot('voice auto: composing')} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">auto · microphone muted</span>
        <VoiceActivitySection {...slot('voice auto: microphone muted')} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">manual · recording</span>
        <VoiceActivitySection {...slot('⠹ voice: recording 1:07')} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">manual · transcribing</span>
        <VoiceActivitySection {...slot('voice: transcribing')} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">microphone owned by another tab</span>
        <VoiceActivitySection {...slot('voice auto: listening', CONFLICT_SESSION)} />
      </div>
    </div>
  ),
};
