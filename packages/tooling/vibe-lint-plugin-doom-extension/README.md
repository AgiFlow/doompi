# @agimon-ai/vibe-lint-plugin-doom-extension

Deterministic Vibe-Lint rules for publishable DoomPi extension packages.

## Install

```bash
pnpm add -D @agimon-ai/vibe-lint @agimon-ai/vibe-lint-plugin-doom-extension
```

## Configure

Vibe-Lint resolves the short plugin name to this package:

```yaml
plugins:
  - core
  - doom-extension

extends:
  - core/recommended
  - doom-extension/recommended
```

Use `doom-extension/migration` to enable every rule at warning severity while migrating an existing package.

Package-owned Help prompts live under `src/prompts/<prompt-name>/SKILL.md`. The
`doom-prompt-shape` rule checks their directory names, frontmatter, `llms.txt`
links, and publish allowlist entry. Prompt support resources may remain beside
the skill in standard `references`, `scripts`, `assets`, and `agents` folders.

The Cordis rules enforce one runner-owned host, host-first/finalizer-last activation in the final activation array, exactly one captured feature lease and plugin fiber, and control-flow-ordered shutdown of the fiber before its lease. A provider may publish only from the context owned by its mounted plugin or an owned injection; package-wide publication does not satisfy that boundary. Required services must be owned by `ctx.inject`, and a stable Pi wrapper must identity-check and clear its active binding from that injection's cleanup when the provider unloads.

Pi EventBus use is followed through local aliases and helper parameters and is reserved for the versioned host query. Same-runner runtime protocol imports are denied by default except for passive protocol error classes. Live `global` or `globalThis` capability registries are rejected; the exact reload-handoff and bootstrap-claim modules remain exceptions only while they retain their TTL/generation or identity/release fences.

## Public API

The default export is the Vibe-Lint plugin contract. The package also exports `doomExtensionPlugin`, `rules`, `recommended`, `migration`, and each deterministic rule definition as named exports.
