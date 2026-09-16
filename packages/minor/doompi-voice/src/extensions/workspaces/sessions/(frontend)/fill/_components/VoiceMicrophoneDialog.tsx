import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  handleOptionListKey,
  OptionList,
  optionListHint,
} from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useState } from 'react';

import { voiceMicrophone } from '../../_lib/voiceMicrophoneStore';

interface MicrophoneOption {
  deviceId: string;
  label: string;
}

/**
 * Row labels, which `OptionList` also uses as its keys and its selection value.
 * Two microphones reporting the same name are common enough (a pair of USB
 * capsules) that collapsing them into one answer would pick the wrong device.
 */
export function microphoneOptions(inputs: readonly MicrophoneOption[]): string[] {
  const name = (index: number): string => inputs[index]?.label || 'Microphone';
  return inputs.map((input, index) =>
    inputs.some((_, other) => other !== index && name(other) === name(index))
      ? `${name(index)} · ${input.deviceId.slice(0, 6)}`
      : name(index),
  );
}
/**
 * Which input autonomous voice should open, asked once.
 *
 * It appears only when the client has more than one input and no saved answer matches
 * the current set; one input needs no question, because the browser already knows the
 * answer. Escape starts on the browser default for this activation only, so a mistaken
 * dismissal is not permanent.
 */
export function VoiceMicrophoneDialog() {
  const { inputs, choice } = useStore(voiceMicrophone.store, (state) => state);
  const [cursor, setCursor] = useState(0);
  if (choice === undefined) return null;

  const options = microphoneOptions(inputs);
  const active = cursor < options.length ? cursor : 0;
  const pick = (option: string): void => {
    const input = inputs[options.indexOf(option)];
    if (input !== undefined) choice(input.deviceId, true);
  };

  return (
    <Dialog
      open
      onOpenChange={(next: boolean) => {
        if (!next) choice(null, false);
      }}
    >
      <DialogContent
        width="sm"
        data-testid="voice-microphone-dialog"
        aria-describedby={undefined}
        onKeyDown={(event) =>
          handleOptionListKey(event, { options, cursor: active, onCursorChange: setCursor, onSelect: pick })
        }
      >
        <DialogHeader>
          <DialogTitle>choose a microphone</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>
            autonomous voice found more than one input. this browser remembers the one you pick.
          </DialogDescription>
          <OptionList
            options={options}
            cursor={active}
            onCursorChange={setCursor}
            onSelect={pick}
            testIdPrefix="voice-microphone-option"
          />
          <DialogFooter>
            <span className="w-full text-xs text-doom-faint">
              {optionListHint(options.length)} · esc uses the browser default once
            </span>
            <Button
              variant="outline"
              size="md"
              data-testid="voice-microphone-default"
              onClick={() => choice(null, true)}
            >
              always use browser default
            </Button>
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
