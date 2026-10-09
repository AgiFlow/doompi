---
name: doompi-use-chatgpt-instructions
description: 'Print a paste-ready ChatGPT project instruction using session tools and every repository rule. Writes no files.'
---

# ChatGPT project instructions

Write no files. Ask: "What is the ChatGPT connector (plugin) name, and what tool prefix does it use? The default prefix is mcp_proxy."

Read root AGENTS.md using this session's read tool. If missing, omit Repository rules and report that it is missing. Use this session's tools and their schemas as the source for Tools, not a fixed product inventory. Generate one short line per tool or group with unprefixed names. Do not include product-specific content in the generated instruction.

Condense every AGENTS.md rule into Repository rules. Preserve commands, paths, package names, and exceptions word for word. Shorten wording only, never drop a rule. Replace placeholders below with the supplied connector and prefix, safely escaped as JavaScript string literals.

The entire output must be at most 8,000 characters, including fences, count, and notices. Count characters with a read-only session command such as printf '%s' ... | wc -m without writing a file. Without a shell, label the count estimated and use a conservative upper bound. Never accept an estimated count over the limit. Shorten tool lines first, then wording. If every rule still cannot fit, report the rules that do not fit instead of printing a block that drops rules. Do not print a block unless the strict maximum is satisfied.

Output exactly one four-backtick fenced block containing the completed template (its js fence is nested), followed by Character count: N (or an explicitly estimated upper bound). State outside the block that connector calls were not tested. Use no em-dashes.

## Template

# <PLUGIN> tools in code mode

Work runs on the session host repository. Do not use a local shell, Python, file tools, or local paths.

## Calling tools

Call tools from exec through the global tools object, never through tool search. ALL_TOOLS lists them all. Begin every exec with:

```js
const P = '<PREFIX>_';
const T = Object.create(null);
for (const t of ALL_TOOLS) {
  const i = t.name.lastIndexOf(P);
  if (i < 0) continue;
  const n = t.name.slice(i + P.length);
  if (Object.hasOwn(T, n)) throw new Error(`duplicate ${n}: ${T[n]}, ${t.name}; select the connector namespace`);
  T[n] = t.name;
}
const call = async (n, a = {}) => {
  if (!T[n]) throw new Error(`no ${n}; have ${Object.keys(T)}`);
  const r = await tools[T[n]](a);
  text(JSON.stringify(r, null, 1));
  return r;
};
```

If duplicate matches occur across plugins, stop and select the confirmed plugin namespace using ALL_TOOLS metadata or exact fully qualified names before rebuilding T. Never silently select a duplicate short name. Calls always use exact ALL_TOOLS names.

In the first exec of a chat, print Object.keys(T), then call load_context. If T is empty, print the ALL_TOOLS names and stop. Await every call, print its result, and check isError. Codes are in structuredContent.code. Read arguments from the tool's ALL_TOOLS description and schema. Load skills with call('load_skill', { name }).

## When a call fails

- TOOL_CALL_FAILED and SESSION_RESULT_WITHHELD: inspect state before retrying.
- SESSION_BUSY: the call did not start. Retry once after the turn finishes.
- SESSION_TOOL_SURFACE_CHANGED: follow its message once.
- A name missing from T does not prove it is ungranted. Confirm once with session_capabilities, then tell the user. If that wrapper is missing too, report inability to confirm.
- load_extra_tools lists tools added or changed after your catalog loaded. Empty means nothing was added or changed, not that existing tools are missing. Run a returned tool through use_extra_tools with the exact returned name.
- "Skill is not granted or active": continue without it.
- Quote exact error messages. If the cause is unknown, say "cause not established".

## Tools

<One short line per session tool or group. ALL_TOOLS is authoritative; the session inventory can differ from this connection's grants.>

## Repository rules

<Every root AGENTS.md rule condensed, preserving exact commands, paths, package names, and exceptions>
