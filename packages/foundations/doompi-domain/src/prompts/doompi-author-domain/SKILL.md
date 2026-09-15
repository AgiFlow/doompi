---
name: doompi-author-domain
description: Configure DoomPi plugin catalogs and domain resource selections in domains.yaml. Use when creating or editing .doom/domains.yaml or ~/.pi/.doom/domains.yaml, choosing local, Git, or npm plugins, filtering plugin resources, setting aliases or defaults, or verifying resolved domain composition.
---

# Author DoomPi domain configuration

Keep plugin locations in `plugins` and make domains refer to catalog IDs. Do not put filesystem paths directly in a domain's `plugins` list.

Before editing, read both `~/.pi/.doom/domains.yaml` and the repository's `.doom/domains.yaml` when they exist. Preserve their layered ownership and resolve every relative path from the file that declares it.

Use the smallest source form that preserves intent. Pin Git sources with `sha` and npm sources with an exact `version` when reproducibility matters. Use a domain plugin mapping only when the domain needs resource filters or must disable plugin hooks or MCP.

Give a domain an `mcp.servers` allowlist when its work does not need every configured server. Tool schemas are always-on context, so this is usually the largest saving a domain can make, and it is worth more than trimming skills. Filtering activates only when every selected domain declares `mcp`, so migrate the domains that get selected together or the selection stays unfiltered.

After editing, validate the intended selection with `doompi --domains <name[,name...]> --explain` and compare the reported context cost against the previous selection, then run `doompi sync --check`. Run mutating `doompi sync` only when the user intends to materialize or refresh synchronized artifacts.

Read [references/domains-contract.md](references/domains-contract.md) for the complete schema, precedence rules, source forms, filters, and verification checks.
