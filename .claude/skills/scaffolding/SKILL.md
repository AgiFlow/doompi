---
name: scaffolding
description: Use scaffold-mcp CLI commands for project boilerplates, feature
  scaffolds, template authoring, and scaffold-backed file creation. Trigger
  before creating new files, when adding
  routes/components/services/packages/apps, when listing available scaffolds, or
  when replacing legacy scaffold tool usage.
commands:
  - ^pnpm\s+exec\s+scaffold-mcp\b
metadata:
  paths:
    - templates/**/scaffold.yaml
    - templates/**/*.liquid
    - project.json
    - '**/project.json'
---

# Scaffolding

Use `pnpm exec scaffold-mcp`, not MCP tools, for scaffolding. Run a list or info command before manually creating files unless the user explicitly asks for hand-written files.

## Commands

```bash
pnpm exec scaffold-mcp boilerplate list
pnpm exec scaffold-mcp boilerplate info <name>
pnpm exec scaffold-mcp boilerplate create <name> --vars '<json>'

pnpm exec scaffold-mcp scaffold list <project-path>
pnpm exec scaffold-mcp scaffold list --template <template-name>
pnpm exec scaffold-mcp scaffold info <feature-name> --project <project-path>
pnpm exec scaffold-mcp scaffold add <feature-name> --project <project-path> --vars '<json>'
```

## Template Authoring

```bash
pnpm exec scaffold-mcp boilerplate generate <name> --template <template> --description '<text>' --target-folder <folder> --variables '<json>'
pnpm exec scaffold-mcp scaffold generate <name> --template <template> --description '<text>' --variables '<json>'
pnpm exec scaffold-mcp template file create <file-path> --template <template> --content-file <path>
pnpm exec scaffold-mcp file write <file-path> --content-file <path>
```

## Rules

- Use `boilerplate list` before creating a new project or package.
- Use `scaffold list <project-path>` before adding files to an existing project.
- Use exact variable names from `boilerplate info` or `scaffold info`.
- Use `--vars '<json>'` with valid JSON. Prefer single quotes around the JSON in shell commands.
- Keep generated files within the target project and review them before custom edits.
- Run the relevant `nx typecheck`, `nx test-*`, or `nx fixcode` target after generated code is implemented.
