# @agimon-ai/doompi-user-feedback

Structured user questions that wait for an answer in interactive Pi sessions, with an autonomous
Voice handoff.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

The `ask_user_question` tool presents concrete options instead of asking the model to continue on a
guess.

> **Alpha:** tool and Voice-handoff contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.84.2 and Pi TUI 0.84.2

## Install

Add the package to a DoomPi layer. DoomPi preserves authored layer and package occurrence order,
while activating this package once per canonical resolved path:

```yaml
layers:
  feedback:
    packages: ['@agimon-ai/doompi-user-feedback']
```

For standalone Pi:

```bash
pi install npm:@agimon-ai/doompi-user-feedback
```

Pi loads the package through `package.json.pi.extensions`. Each factory invocation owns one package
instance. Session replacement resets its state, and shutdown removes its registrations.

## Ask a question

```json
{
  "questions": [
    {
      "header": "Storage",
      "question": "Where should session results be stored?",
      "options": [
        {
          "label": "Project files",
          "description": "Easy to inspect and commit, but visible in the repository."
        },
        {
          "label": "User state",
          "description": "Keeps generated state outside the repository."
        }
      ],
      "multiSelect": false
    }
  ]
}
```

A call accepts 1 to 4 questions. Each question requires 2 to 4 options. Headers are at most 16
characters; option labels are at most 60 characters. Use `multiSelect: true` when several choices
are valid. An option can include a Markdown `preview` for meaningful visual comparison.

The tool result contains readable answer text plus structured `details.answers`; cancellation sets
`cancelled: true`. Pressing Escape declines the questionnaire. Do not add an `Other` option because
the UI supplies a custom-text row.

## UI, RPC, and headless behavior

The tool requires an interactive UI. It uses the TUI questionnaire when available and can use Pi's
dialog or RPC UI bridge. A headless context without either UI returns a structured `no_ui`
cancellation rather than waiting forever.

Questionnaires are coordinated one at a time. Cancellation, session replacement, or shutdown
aborts the active prompt and settles queued work.

## Autonomous Voice

While autonomous Voice mode is active, `ask_user_question` leaves Pi's active tool set. Voice already
speaks its own question through `narrate` and then waits for the spoken reply, so keeping a
questionnaire tool alongside it asks the same thing twice. The agent asks by narrating, and the
answer arrives as an ordinary user message.

The gate tracks its own removal. A tool switched off by the user stays off, no other package's tools
are touched, and the removal is restored when Voice deactivates, when the Voice services unload, or
when this runtime shuts down.

A call already in flight when Voice activates still hands off: the extension formats the questions as
plain text, requests narration, and returns `terminate: true`, ending the turn while it waits.

Both paths use the shared `doom/minor-mode-catalog` and `doom/narration` Cordis services. If a
provider unloads, User Feedback restores the tool and falls back to its interactive questionnaire
without retaining the old provider.

## Public API

Question and result types are available from the package root. Cross-extension ask-user events and
Voice services come from `@agimon-ai/doompi-extension-contracts`; consumers should use those Cordis
contracts. Pi loads the default export of `/extensions/pi` through package metadata, so installation
does not require a manual registration call.

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
