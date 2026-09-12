/*
 * Plain CSF objects: the style-system renderer parses this file statically and
 * mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { VoiceToolMessage } from './VoiceToolMessage';
import { VOICE_DESCRIBE_TOOL, VOICE_NARRATE_TOOL, VOICE_TRANSFER_TOOL, VOICE_USE_TOOL } from '../lib/voiceToolRender';

const props = (overrides: Parameters<typeof toolMessagePropsFixture>[0]) => toolMessagePropsFixture(overrides).props;

const CATALOG = {
  content: [],
  details: {
    catalogRevision: 7,
    tools: [
      {
        name: 'set_timer',
        label: 'Set a timer',
        enabled: true,
        description: 'Starts a countdown and announces it when it ends.',
        inputSchema: { type: 'object', properties: { minutes: { type: 'number' } }, required: ['minutes'] },
      },
      { name: 'play_music', label: 'Play music', enabled: false },
    ],
    conflicts: [{ name: 'set_timer', message: 'Two extensions register this name.' }],
    unknownNames: ['open_garage'],
  },
};

const BATCH = {
  content: [],
  details: {
    status: 'completed',
    results: [
      { name: 'set_timer', status: 'completed', result: { minutes: 10, endsAt: '14:42' } },
      { name: 'play_music', status: 'rejected', error: { message: 'The capability is disabled.' } },
    ],
    errors: [],
  },
};

const meta = {
  title: 'Voice/VoiceToolMessage',
  component: VoiceToolMessage,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">narrate · spoken, as a message</span>
        <VoiceToolMessage
          {...props({
            toolName: VOICE_NARRATE_TOOL,
            args: { text: 'The plan panel is open and the first three steps are done.' },
            result: { content: [], details: { outcome: 'completed' } },
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">narrate · playing</span>
        <VoiceToolMessage
          {...props({
            toolName: VOICE_NARRATE_TOOL,
            args: { text: 'Reading the reply aloud now.' },
            running: true,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">describe_voice_tools · catalog</span>
        <VoiceToolMessage
          {...props({ toolName: VOICE_DESCRIBE_TOOL, args: { names: ['set_timer'] }, result: CATALOG })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">use_voice_tools · batch</span>
        <VoiceToolMessage
          {...props({
            toolName: VOICE_USE_TOOL,
            args: { calls: [{ name: 'set_timer' }, { name: 'play_music' }] },
            result: BATCH,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">transfer_voice · handed off</span>
        <VoiceToolMessage
          {...props({
            toolName: VOICE_TRANSFER_TOOL,
            args: { target: 2 },
            result: { content: [{ type: 'text', text: 'Voice moved to session 2.' }], details: null },
            output: 'Voice moved to session 2.',
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <VoiceToolMessage
          {...props({
            toolName: VOICE_USE_TOOL,
            args: { calls: [{ name: 'set_timer' }] },
            result: {
              content: [],
              details: { error: { message: 'The voice broker is not running.', retryable: true } },
            },
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
