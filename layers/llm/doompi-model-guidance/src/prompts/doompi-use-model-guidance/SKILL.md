---
name: doompi-use-model-guidance
description: 'Use @agimon-ai/doompi-model-guidance: per-model system prompt guidance, layered across global and repository scope'
---

# Use Model Guidance

Read the package [README](../../../README.md) for its exact installation, configuration, and behavior.

## Guidance

Write guidance for a model id in either scope:

- Global, applying to every repository: `~/.pi/.doom/model-guidance.yaml`
- Repository, applying to one project: `<repository>/.doom/model-guidance.yaml`

```yaml
modelGuidance:
  claude-opus-5: |
    Keep the task focused. Never go off rails.
```

Model ids match exactly. Use the id shown by `/model`, not a family or a
marketing name. An id that does not match contributes nothing and never errors,
so a silent absence of guidance usually means the id is wrong.

Both scopes apply. A repository entry replaces the global entry for the model
ids it names, and global entries for other ids still apply.

Guidance is read per turn, so an edit takes effect on the next message with no
restart.
