# @agimon-ai/doompi-model-guidance

Per-model system prompt guidance for Pi agents, layered across global and repository scope.

A new model release often needs prompt adjustments that older models do not.
This package keeps those adjustments in one place, keyed by model id, instead of
spreading them through every package's prompt.

## Configuration

Guidance lives in `model-guidance.yaml`, read from two scopes:

| Scope      | Path                                     |
| ---------- | ---------------------------------------- |
| Global     | `~/.pi/.doom/model-guidance.yaml`        |
| Repository | `<repository>/.doom/model-guidance.yaml` |

```yaml
modelGuidance:
  claude-opus-5: |
    Keep the task focused. Never go off rails.
  gpt-6-astra: |
    Prefer fewer, larger tool batches.
```

### Matching

Model ids match exactly, against the id Pi reports for the active model. Use the
value shown by `/model`. A model with no entry gets no guidance, which is never
an error, so missing guidance usually means the id does not match.

Exact matching is deliberate: it keeps the file honest about which model a piece
of text was written for. The cost is that a provider shipping a new versioned id
needs a new entry.

### Merge rule

Both scopes apply. A repository entry wins for the model ids it names, and
global entries for ids the repository does not mention still apply.

| Model id        | Global          | Repository            | Result                |
| --------------- | --------------- | --------------------- | --------------------- |
| `claude-opus-5` | "Stay focused." | "Cordis rules apply." | "Cordis rules apply." |
| `gpt-6-astra`   | "Batch tools."  | absent                | "Batch tools."        |
| `local-qwen-3`  | absent          | "Short answers only." | "Short answers only." |

A malformed or unreadable guidance file warns on stderr and yields no guidance,
rather than ending the session.

## Activation

The package ships in the `llm` layer and is optional.

Mode-scoped, in `.doom/modes.yaml`:

```yaml
layers:
  llm:
    packages:
      - '@agimon-ai/doompi-model-guidance'

majorMode:
  copilot:
    layers: [team, ask-user, task, sandbox, llm]
```

Always on, by listing it in the `default` package list instead:

```yaml
default:
  packages:
    - '@agimon-ai/doompi-model-guidance'
```

A layer only activates when the selected major mode lists it, so add `llm` to
every major mode that should carry guidance. The `default` route avoids that but
makes ordering depend on list position.

## Behaviour

Guidance is appended to the system prompt at the start of each turn, after the
default packages have contributed and before the profile persona. The file is
read per turn, so an edit takes effect on the next message with no restart.

## Development

```bash
pnpm nx run @agimon-ai/doompi-model-guidance:lint
pnpm nx run @agimon-ai/doompi-model-guidance:typecheck
pnpm nx run @agimon-ai/doompi-model-guidance:build
pnpm nx run @agimon-ai/doompi-model-guidance:test
```

Pi entrypoint: `./dist/extensions/pi.mjs`.
