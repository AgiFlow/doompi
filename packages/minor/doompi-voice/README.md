# @agimon-ai/doompi-voice

Capture speech on the client, transcribe it on the host, and play responses through DoomPi Voice mode.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

Voice can transcribe one recording or keep the currently active session listening. It also gives
the primary agent a bounded `narrate` tool and accepts narration requests from other extensions.

> **Alpha:** Voice state, tool, and platform support may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.84.3
- A browser with microphone capture and speech synthesis when using `doompi-web`
- For standalone terminal use on macOS, FFmpeg capture and `say` playback
- One supported local transcription engine: `whisper-cli`, `whisper`, or `mlx_whisper` (Apple
  silicon only)
- Microphone permission on the client device

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
    composeOpenPhrases: [hey doom]
    composeSendPhrases: ["that's it"]
    composeCancelPhrases: [scratch that]
    utteranceIdleMs: 3000
    composeUtteranceIdleMs: 1200
    composeNudgeMs: 10000
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

When the agent is launched by `doompi-server`, capture and narration use the connected media client.
The protocol is capability-driven rather than browser-specific. A client can own microphone capture,
adaptive activity detection, endpoint decisions, autonomous capture phases, and playback while streaming
mono 16 kHz PCM16 through the authenticated session media API. The host supplies capabilities the client
does not advertise and remains responsible for durable spooling, configured transcription, and Pi or
model actions. This boundary supports terminal, web, React Native, and future watch adapters without
putting platform APIs in the shared client runtime.

A browser using the sealed remote-control channel takes the session media lease from a local client, so
narration and capture follow the user to the remote device. Local clients cannot take that lease back
while the remote client remains connected. Standalone terminal launches retain the macOS FFmpeg and
`say` adapters as a host-owned fallback. In the browser, `tts.voice` selects an exact
SpeechSynthesis voice name or URI. If it does not match, the browser uses its default voice. Portable
clients implement the declared ports through `@agimon-ai/doompi-voice/client-media`.

## Commands and tools

- `SPC v v` records and transcribes once; it does not enable autonomous Voice tools.
- `SPC v e` enters autonomous capture and exits it again.
- While autonomous capture is active, say `hey doom` at the beginning of a segment to open a long composed prompt. Later finalized segments are buffered until `that's it` submits the combined text or `doom cancel` discards it.
- `describe_voice_tools` returns the active session's spoken capability catalog.
- `use_voice_tools` executes a bounded ordered batch against that catalog.
- `narrate` speaks one primary-agent-authored utterance and waits for physical playback.

Composition is for long spoken prompts, so a multi-part prompt is not submitted half-written. A short utterance needs no phrase and is delivered as soon as it finalizes.

All three phrase sets are configurable and each ships with two defaults: `composeOpenPhrases` is `hey doom, doom prompt`, `composeSendPhrases` is `that's it, doom send`, and `composeCancelPhrases` is `doom cancel, scratch that`. Matching ignores case, punctuation and apostrophes, and tolerates small transcription differences, so `thats it` and `doom sent` are recognised. Send and cancel act as commands only while a draft is open, and only when the phrase is the whole segment or ends a sentence, so ordinary dictation containing those words stays content. While a draft collects, the endpoint window shortens to `composeUtteranceIdleMs` (default 1,200 ms) so a short command finalizes as its own turn. A composed prompt is queued as a Pi follow-up while Pi is busy.

Drafts are held in memory for the active autonomous session and are limited to 32,768 characters. Worker restarts and five-minute idle capture rotation preserve the draft, but deactivation, extension reload, and process restart discard it. Wait until the status returns to `composing, listening` before speaking the next segment because capture pauses during transcription.

Before a final response, narration contains the complete answer, including every user-relevant
conclusion, question, warning, result, and next action in the written response. It does not use
a shorter spoken summary that leaves essential information only in text. Each narration is
limited to 4,096 characters and returns `completed`, `interrupted`, `superseded`, or `failed`.
Narration fails closed while Voice is starting or draining, during shutdown, reload, or
deactivation, and when the request belongs to a stale session.
Only the currently active TUI session receives Voice-owned tools.

If no `narrate` attempt is made before a final response, the active Voice session can produce one
bounded fallback utterance. Short final responses use deterministic text; longer ones may use
`autoCapture.model` for one bounded summary and fall back to a deterministic excerpt on failure.
These optional model calls consume provider quota.

## Data flow and recovery

The selected client captures audio. When it advertises client orchestration, its portable PCM state
machine performs activity detection and endpointing, then sends phase metadata with the streamed audio.
Clients without those capabilities use host adaptive and neural VAD as a fallback. PCM validation,
spooling, WAV creation, normalization, and configured local Whisper execution run on the host in a
private supervised worker. Private spool directories use mode `0700` and files use `0600`.
Unacknowledged turns can be rediscovered after a worker restart.

This is not a blanket “nothing leaves the machine” guarantee:

- Client PCM crosses the authenticated cockpit transport, is queued transiently in memory, and is
  persisted only in the host worker's private spool.
- Transcript candidates and bounded state strings cross the worker/process boundary.
- Pi receives transcript text as user input.
- Command correction and long-final fallback text can be sent to the configured model provider.
- Telemetry may contain bounded operational metadata; review its sink configuration.

Manual recordings and autonomous spool windows are bounded to five minutes. Deactivation or
cancellation interrupts pending capture and playback. A manual reload does not silently reactivate
the microphone.

## Architecture

See [Architecture](./docs/ARCHITECTURE.md) for the thread and process topology, the path a single spoken turn takes, the XState lifecycle and how it relates to Pi, the module and cordis service graph, and narration gating and barge-in. [SPEC.md](./docs/SPEC.md) is the normative contract.

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
