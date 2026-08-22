# @agimon-ai/doompi-voice

Speech capture, local transcription engines, playback, and autonomous Voice mode for DoomPi on
macOS.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

Voice can transcribe one recording or keep the currently active session listening. It also gives
the primary agent a bounded `narrate` tool and accepts narration requests from other extensions.

> **Alpha:** Voice state, tool, and platform support may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.84.2
- macOS recording and `say` playback support
- FFmpeg for audio capture
- One supported local transcription engine: `whisper-cli`, `whisper`, or `mlx_whisper` (Apple
  silicon only)
- A microphone permitted by macOS privacy settings

## Install

DoomPi includes Voice in every composition. Standalone Pi loads the same extension:

```bash
pi install npm:@agimon-ai/doompi-voice
```

| Entry                                   | Purpose                                                          |
| --------------------------------------- | ---------------------------------------------------------------- |
| `@agimon-ai/doompi-voice/extensions/pi` | Voice mode, Leader, footer, configuration, and narration runtime |

## Configure

A complete `~/.pi/.doom/config.yaml` example using Python Whisper is:

```yaml
voice:
  engine: openai-whisper
  language: auto
  recorder:
    device: default
  adapters:
    openai-whisper:
      binary: whisper
      model:
        id: base
  autoCapture:
    model: provider/model-id
    startPhrases: []
    stopPhrases: []
    utteranceIdleMs: 3000
    transcriptionTimeoutMs: 120000
    tts:
      engine: macos-say
      voice: Samantha
      rate: 190
```

Replace `provider/model-id` with a model configured in Pi, or omit `autoCapture` when only manual
transcription is required. Use the `whisper-cpp` engine for `whisper-cli`, `openai-whisper` for
`whisper`, or `mlx-whisper` for `mlx_whisper`. `utteranceIdleMs` accepts 1,500 to 10,000 ms and
defaults to 3,000.

## Commands and tools

- `SPC v v` records and transcribes once; it does not enable autonomous Voice tools.
- `SPC v e` enters autonomous capture and exits it again.
- `describe_voice_tools` returns the active session's spoken capability catalog.
- `use_voice_tools` executes a bounded ordered batch against that catalog.
- `narrate` speaks one primary-agent-authored utterance.

Each narration is limited to 4,096 characters, waits for playback, and returns `completed`,
`interrupted`, `superseded`, or `failed`. Narration fails closed while Voice is starting or
draining, during shutdown, reload, or deactivation, and when the request belongs to a stale session.
Only the currently active TUI session receives Voice-owned tools.

If no `narrate` attempt is made before a final response, the active Voice session can produce one
bounded fallback utterance. Short final responses use deterministic text; longer ones may use
`autoCapture.model` for one bounded summary and fall back to a deterministic excerpt on failure.
These optional model calls consume provider quota.

## Data flow and recovery

Capture, PCM validation, activity detection, spooling, WAV creation, normalization, and configured
local Whisper execution run in a private supervised worker. Private spool directories use mode
`0700` and files use `0600`. Unacknowledged turns can be rediscovered after a worker restart.

This is not a blanket “nothing leaves the machine” guarantee:

- PCM/audio remains in local worker storage and playback paths.
- Transcript candidates and bounded state strings cross the worker/process boundary.
- Pi receives transcript text as user input.
- Command correction and long-final fallback text can be sent to the configured model provider.
- Telemetry may contain bounded operational metadata; review its sink configuration.

Manual recordings and autonomous spool windows are bounded to five minutes. Deactivation or
cancellation interrupts pending capture and playback. A manual reload does not silently reactivate
the microphone.

## Public API

The root exports audio infrastructure, PCM, VAD, and utterance services, narration and playback
contracts, command correction, fallback narration, and Voice types. Host adapters should import
only declared package exports, including `/extensions/pi`.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Maintained by [Agimon](https://agimon.ai/about).

## License

MIT
