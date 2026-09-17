---
name: design-workflow
description: Use the DoomPi design workflow for source-backed interactive story design, component discovery, token guidance, validation, and an approved implementation specification.
---

# Source-backed design workflow

Use this workflow when a feature needs an interactive UI target before production integration. The story is a target-state artifact, not a throwaway HTML mockup. Keep the target deterministic and source-backed so it can be reviewed and later connected to real APIs, hooks, stores, and routes.

## Keep context lean

Do not paste an entire component catalog, token list, or design-system manual into the conversation. Discover only what the current surface needs:

```bash
doompi-design list-shared-components
doompi-design list-app-components --app-path <project>
doompi-design get-css-classes --app-path <project> --category all
doompi-design list-themes --app-path <project>
```

If `doompi-design` is unavailable, use the published `@agimon-ai/style-system` CLI with the same commands. The workflow is portable and does not require Pi, DoomPi, Author, or MCP.

Use repository source as the authority for principles and managed tokens. In this repository, begin with:

- `packages/core/doompi-web-components/README.md`
- `packages/core/doompi-web-components/styles/tokens.css`
- the applicable project `style-system.config.yaml`
- applicable Vibe-Lint rule descriptions

The catalog is story-backed and may not include every exported component. Unknown components are unresolved, not proof that no component exists.

## Design

1. Identify the project, user journey, states, interactions, permissions, and responsive constraints.
2. Inspect and reuse an existing shared or application component before creating one.
3. Define deterministic fixtures for loading, empty, error, populated, and interaction states.
4. Build a Storybook story for a presentational View. Keep API hooks, stores, router calls, SDK calls, and side effects in a Container outside the story.
5. Use the configured semantic tokens and primitives. Do not invent raw palette values or arbitrary scale values to make a screenshot look right.
6. Build the interactive preview explicitly and inspect the actual interaction states. Generated HTML is a disposable artifact.
7. Edit the underlying story or component source, never generated preview HTML.

Rendering and component capture execute trusted workspace source. Do not run a file-polishing or mutating design command during review unless the user explicitly asks for that edit.

## Check

Run the explicit bounded check for the target after the story and relevant styles change:

```bash
doompi-design check --target <target-manifest.json>
```

The check is static and bounded. It reports separately:

- confirmed policy violations, such as raw theme colors or arbitrary scale values;
- recognized static classes and managed tokens;
- unresolved dynamic expressions, custom selectors, missing imports, or unsupported configuration;
- checked inputs, coverage limits, tool versions, and fingerprints.

A Tailwind class being recognized does not make it compliant. A missing generated class does not by itself make a class invalid because marker classes and ordinary custom CSS may be valid. Dynamic expressions and incomplete CSS context must not be reported as clean.

Resolve all required findings. A successful build, typecheck, or image render is not a design-compliance result.

## Approval and specification

After checks pass, inspect the preview and ask the user to explicitly approve the exact target snapshot, including story/export, fixtures, rendering options, and evidence revision. Do not infer approval from agent prose or a model-written field.

Only after explicit target approval, inspect the current implementation and write a repository Markdown bridge specification. Reuse the repository's existing Plan review and acceptance conventions when available. The spec should map each approved target component, state, action, and route to:

- current API, hook, store, and route source references;
- reused, adapted, or new components;
- data and permission contracts;
- loading, empty, error, and responsive behavior;
- mock-to-production integration work;
- executable acceptance checks, sequence, non-goals, and unresolved decisions.

Store the target and evidence with the project, for example:

```text
docs/specs/<feature>/target.md
docs/specs/<feature>/design-check.json
docs/specs/<feature>/spec.md
```

The target approval does not authorize implementation. Request separate implementation approval.
