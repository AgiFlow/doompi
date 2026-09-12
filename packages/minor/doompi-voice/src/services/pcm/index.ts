export const PCM_SAMPLE_RATE = 16_000;
export const PCM_CHANNELS = 1;
export const PCM_BITS_PER_SAMPLE = 16;
export const PCM_FRAME_MS = 20;
export const PCM_BYTES_PER_SAMPLE = PCM_BITS_PER_SAMPLE / 8;
export const PCM_FRAME_BYTES = (PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_BYTES_PER_SAMPLE * PCM_FRAME_MS) / 1_000;

const WAV_HEADER_BYTES = 44;
const WAV_RIFF_CHUNK = 'RIFF';
const WAV_FORMAT = 'WAVE';
const WAV_FORMAT_CHUNK = 'fmt ';
const WAV_DATA_CHUNK = 'data';
const PCM_FORMAT = 1;

export class PcmFrameAssembler {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    if (chunk.length === 0) return [];
    const combined = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const completeBytes = combined.length - (combined.length % PCM_FRAME_BYTES);
    const frames: Buffer[] = [];
    for (let offset = 0; offset < completeBytes; offset += PCM_FRAME_BYTES) {
      frames.push(Buffer.from(combined.subarray(offset, offset + PCM_FRAME_BYTES)));
    }
    this.pending = Buffer.from(combined.subarray(completeBytes));
    return frames;
  }

  flush(): Buffer {
    const remainder = this.pending;
    this.pending = Buffer.alloc(0);
    return remainder;
  }
}

export function encodePcm16Wav(pcm: Buffer): Buffer {
  if (pcm.length % PCM_BYTES_PER_SAMPLE !== 0) throw new Error('PCM input must contain complete 16-bit samples');
  const byteRate = PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_BYTES_PER_SAMPLE;
  const blockAlign = PCM_CHANNELS * PCM_BYTES_PER_SAMPLE;
  const wav = Buffer.alloc(WAV_HEADER_BYTES + pcm.length);
  wav.write(WAV_RIFF_CHUNK, 0);
  wav.writeUInt32LE(WAV_HEADER_BYTES - 8 + pcm.length, 4);
  wav.write(WAV_FORMAT, 8);
  wav.write(WAV_FORMAT_CHUNK, 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(PCM_FORMAT, 20);
  wav.writeUInt16LE(PCM_CHANNELS, 22);
  wav.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(PCM_BITS_PER_SAMPLE, 34);
  wav.write(WAV_DATA_CHUNK, 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, WAV_HEADER_BYTES);
  return wav;
}
