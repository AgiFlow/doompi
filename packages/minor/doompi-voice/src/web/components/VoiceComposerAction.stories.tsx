/*
 * Plain CSF objects: the style-system renderer parses this file statically and
 * mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 *
 * Only the states the props reach are here. Recording, starting and
 * transcribing come from the button's own recorder, which opens the microphone
 * through getUserMedia; the headless renderer has no device to grant, so
 * driving it would be faking the one thing the button reports.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { VoiceComposerAction } from './VoiceComposerAction.tsx';

const slot = (status?: string, sessionId: string | null = 's1') =>
  slotPropsFixture({ sessionId, statuses: status === undefined ? {} : { 'doom-voice': status } }).props;

const meta = {
  title: 'Voice/VoiceComposerAction',
  component: VoiceComposerAction,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">idle · ready to dictate</span>
        <div className="flex items-center gap-2">
          <VoiceComposerAction {...slot()} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">blocked · autonomous voice is on</span>
        <div className="flex items-center gap-2">
          <VoiceComposerAction {...slot('voice auto: listening')} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no session · disabled</span>
        <div className="flex items-center gap-2">
          <VoiceComposerAction {...slot(undefined, null)} />
        </div>
      </div>
    </div>
  ),
};
