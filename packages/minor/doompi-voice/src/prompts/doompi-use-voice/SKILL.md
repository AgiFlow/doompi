---
name: doompi-use-voice
description: Use Doom Pi Voice for manual transcription, autonomous capture, narration, configuration, and recovery on macOS.
---

# Use Doom Pi Voice

Use Voice on macOS when the user wants spoken input, spoken output, or an autonomous listening session.

## Choose the interaction

- Use `SPC v v` for one manual recording and transcription. This does not activate autonomous Voice tools.
- Use `SPC v e` to enter autonomous capture for the current session, and again to exit it.
- Call `describe_voice_tools` before any batch. It lists the registered capabilities and returns the `catalog_token` that `use_voice_tools` requires; there is no other source for that token.
- Call `describe_voice_tools` again with `names` to read a capability's `input_schema` before running it. The bare call returns names and descriptions only.
- Call `use_voice_tools` with that exact `catalog_token` and a bounded, ordered batch. Every call is preflighted together, so one invalid input rejects all of them.
- Treat a `VOICE_TOOL_STALE_CATALOG` rejection as a moved catalog. Use the fresh token returned with the rejection, or describe again. Do not resend the rejected token.
- Use `narrate` for one primary-agent-authored utterance. Before a final response, speak the complete answer, including every user-relevant conclusion, question, warning, result, and next action. Never leave essential information only in the written response.

## Configure and verify

1. Confirm macOS microphone permission, FFmpeg, playback through `say`, and one supported local transcription engine.
2. Configure `voice` in `.doom/config.yaml` or the global Doom config. Match the adapter to the installed binary: `whisper-cpp` for `whisper-cli`, `openai-whisper` for `whisper`, or `mlx-whisper` for `mlx_whisper`.
3. Set `autoCapture.model` only when autonomous command correction or bounded final-response summarization may call a configured model provider.
4. Activate Voice and check the TUI activity state before relying on capture or narration.

## Operate safely

- Treat microphone activation as session-scoped. Reload and deactivation do not silently reactivate it.
- Expect pending capture and playback to stop during deactivation, cancellation, reload, or shutdown.
- Audio remains in private local worker storage, but transcripts enter Pi as user input and some bounded text may reach the configured model provider.
- If Voice reports a stale session, starting, draining, or failed state, do not retry blindly. Recheck configuration and the current session, then activate again only with user intent.
