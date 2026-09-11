---
name: doompi-use-model-guidance
description: 'Use @agimon-ai/doompi-model-guidance: per-model system prompt guidance, layered across global and repository scope'
---

# Use Model Guidance

Read the package [README](../../../README.md) for its exact installation, configuration, and behavior.

## Guidance

Importing the package as a bare entry in `modes.yaml` activates its built-in
`default` preset, including the package guidance for `gpt-6-astra`.

Override or add guidance for a model id in either scope:

- Global, applying to every repository: `~/.pi/.doom/model-guidance.yaml`
- Repository, applying to one project: `<repository>/.doom/model-guidance.yaml`

```yaml
modelGuidance:
  claude-opus-5: |
    Keep the task focused. Never go off rails.
```

Model ids match exactly. Use the id shown by `/model`, not a family or a
marketing name. A model with no custom entry uses its built-in preset entry when
one exists; otherwise it gets no guidance.

The built-in preset applies first. Global guidance overrides it per model id,
then repository guidance overrides global guidance per model id.

Guidance is read per turn, so an edit takes effect on the next message with no
restart.
