# Voice test fixtures

`silero-speech.wav` contains the first 2.5 seconds of the upstream Silero VAD test recording at 16 kHz mono PCM16.

- Upstream file: https://github.com/snakers4/silero-vad/raw/refs/tags/v6.2.1/files/silero_vad_test.wav
- Release: `v6.2.1`
- License: MIT, matching the Silero VAD repository license reproduced in `../../models/SILERO-LICENSE`

The regression test attenuates this recording in memory to exercise quiet-speech detection.
