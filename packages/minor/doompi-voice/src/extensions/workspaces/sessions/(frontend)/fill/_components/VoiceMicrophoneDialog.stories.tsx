import { voiceMicrophone } from '../../_lib/voiceMicrophoneStore';
import { VoiceMicrophoneDialog } from './VoiceMicrophoneDialog';

const meta = {
  title: 'Voice/VoiceMicrophoneDialog',
  component: VoiceMicrophoneDialog,
  tags: ['style-system'],
};

export default meta;

function preview(duplicateLabels = false) {
  voiceMicrophone.update(() => ({
    inputs: [
      { deviceId: 'builtin-1', groupId: 'builtin', label: duplicateLabels ? 'USB Microphone' : 'Built-in microphone' },
      { deviceId: 'usbmic-2', groupId: 'usb', label: 'USB Microphone' },
      { deviceId: 'headset-3', groupId: 'headset', label: 'External headset with a long descriptive device name' },
    ],
    choice: () => voiceMicrophone.update((state) => ({ ...state, choice: undefined })),
  }));
  return (
    <div className="min-h-screen bg-doom-bg">
      <VoiceMicrophoneDialog />
    </div>
  );
}

export const Playground = { render: () => preview() };
export const DuplicateLabels = { render: () => preview(true) };
