const PROCESSOR_NAME = 'doompi-voice-capture';

class DoomPiVoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    if (input === undefined) return true;
    outputs[0]?.[0]?.set(input);
    this.port.postMessage(input.slice());
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, DoomPiVoiceCaptureProcessor);
