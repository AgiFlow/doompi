# Session MCP

DoomPi Web can expose one live DoomPi session as a remote MCP server. Remote Control supplies the public HTTPS origin. The endpoint exposes only package capabilities explicitly authored as `tool/[name].mcp.ts`, `skill/[name].mcp.ts`, or static UI `resource/[name].mcp.ts` declarations, not the agent's local Pi tools and resources.

This is an inbound connection. It is separate from outbound MCP servers, remote pairing, and Remote Control.

## Connect ChatGPT with an API key

1. Start the session and enable Remote Control with a public HTTPS origin.
2. Open **Settings → Remote control → session MCP** and copy the **MCP URL**.
3. In ChatGPT, create an MCP app using **Server URL** and **API key** authentication with the **Bearer** header.
4. In DoomPi Web, select **API key (Bearer)** and create a key. Paste the one-time key into ChatGPT as the API key value.
5. Keep the key private. Revoke it in DoomPi Web when the connection is no longer needed.

## OAuth with a known redirect URL

DoomPi also supports a host-created OAuth client with an exact HTTPS redirect URL supplied by the connecting client. Select **OAuth (callback required)** and register that URL, then paste the client ID and one-time secret into the client. Use `client_secret_post` with S256 PKCE. The new ChatGPT MCP App form does not show a callback URL, so do not guess one or use the DoomPi MCP URL as a redirect. This manual OAuth registration flow is not currently usable from that form without an independently confirmed redirect URL.

## Skills and worktree-only tools

Remote clients can use `search_skills` to discover repository and active-domain skills, then `load_skill` with an exact skill name to retrieve its current Markdown. Both tools see only skills granted to the connection. Existing skill resources remain available for clients that support MCP resources.

Refresh the MCP tool catalog after deploying these tools, or after reconnecting to a restarted host. Each successful `tools/list` refresh captures the parent session's then-current, grant-filtered tools and skill summaries as the baseline for that credential. After changing a conversation worktree's major mode, minor modes, domains, or profile, call `load_context` and `load_extra_tools` without refreshing the catalog. `load_extra_tools` takes `{}` and returns full tool descriptors plus skill names and descriptions that differ from the cached parent baseline. An empty response means there are no differences; it is not a complete capability inventory. Call `session_capabilities` for the current conversation's grant-filtered tools and skills, surface revision, and baseline status. Invoke an extra tool with `use_extra_tools` using the remote name it returned, for example `{ "name": "myrepo_tool_name", "arguments": {} }` on a connection with the `myrepo` prefix; read a newly available skill with the existing `load_skill`. The target must still be active and separately granted at execution time. Refreshing the parent catalog rebases every conversation sharing the credential. If the host restarts, refresh before using either extra-tool operation.

## Tool name prefix

Each new connection gets a tool name prefix, and every remote tool name becomes `<prefix>_<name>`, for example `myrepo_bash` and `myrepo_read`. This keeps DoomPi tools apart from the remote agent's own `bash`, `read`, `edit`, and similar tools, and gives tool search a distinct name to match.

- Leave the **tool prefix** field blank to use the session name, lowercased with other characters turned into underscores. An empty or `untitled` session name gets a random short word instead.
- A prefix is 1 to 24 lowercase letters or digits joined by single underscores. An invalid prefix is rejected when the connection is created.
- The prefix is fixed when the connection is created. Renaming the session does not change it. To get a different prefix, create a new connection.
- Connections created before prefixes existed keep their bare names. Recreate one to get a prefix.
- Refresh the client's tool catalog after creating or recreating a connection.

On a prefixed connection, only prefixed names are accepted, including the `name` passed to `use_extra_tools`. A bare name such as `bash` is rejected. `load_extra_tools`, `session_capabilities`, and the server instructions all report prefixed names. DoomPi's call history and grants keep the internal names.

## Errors the agent can fix

Mistakes a remote agent can correct come back as tool results with `isError: true`, a readable message, and `structuredContent.code`, so the agent sees them and can retry:

- `TOOL_ARGUMENTS_INVALID`: wrong arguments, with the offending field or key named;
- `TOOL_NOT_AVAILABLE`: unknown, ungranted, or wrongly prefixed tool name;
- `SESSION_TOOL_SURFACE_CHANGED`: the session tools changed before the call ran;
- `SESSION_RESULT_WITHHELD`: the call may have run, but the tools or grants changed, so the result was withheld;
- `TOOL_CALL_FAILED`: the tool did not return a result. Inspect state before retrying a tool that changes files.

These stay JSON-RPC protocol errors: authentication failures, a revoked or replaced grant, a duplicate request ID, too many active calls, a reserved tool-name conflict, revoked skill access, a skill that is not granted, aborted calls, registration save failures, and `resources/read` errors.

## Copy as prompt

The MCP lane in DoomPi Web has a **copy as prompt** button. It copies a short prompt for the remote agent: use the DoomPi tools for work in the session repository instead of its built-in tools, the tool name prefix, when to call `load_context` and the extra-tool pair, and the full tool list with descriptions.

The client name is generated from the trusted Remote Control domain. OAuth callbacks must be exact absolute HTTPS URLs supplied by the client. They are not derived from the DoomPi domain.

Access follows the active major mode, minor modes, domains, and profile, including later changes. Session tools run with the session process's permissions. Granting shell access can reach the filesystem, environment, network, and operating system privileges available to that session. Authentication is not a sandbox. Third-party packages must ship their own explicit MCP declarations to expose capabilities remotely.

## Context

Remote agents can call `load_context` at session startup, and again after a profile or mode change. It returns the session's repository instructions, active persona, and selected profile, domains, major mode, and layers. Instructions are the files loaded when the session started and are limited to the repository. It does not return global or ancestor instructions, environment values, credentials, history, skills, or the assembled system prompt.

The tool follows the same capability grants as every other session MCP tool. A restricted connection must explicitly grant `load_context`.

## OAuth policy

Session MCP uses confidential clients created by the host owner. Public Dynamic Client Registration and Client Identifier Metadata Documents are not supported. Unknown or URL-shaped client IDs are not resolved over the network.

The flow requires an exact registered HTTPS callback, authorization code exchange with S256 PKCE, and `client_secret_post`. Client credentials identify the connector and do not widen the session scope. Access tokens are bound to the exact MCP resource, client, live session incarnation, and session scope.

Client creation is host-only. A paired remote browser or connector credential cannot create a client. Public tunnel routes expose only OAuth discovery, authorization, token exchange, and the Bearer-protected MCP endpoint.

## Lifetime and revocation

API keys are saved for the workspace, session, and exact MCP URL across a DoomPi host restart. OAuth clients are saved after verification; their authorization codes, access tokens, and refresh tokens remain process-local. Reconnect with the existing client credentials and MCP URL, then authorize again if requested.

Changing the public origin, revoking the client or key, or using another workspace or session invalidates the saved registration. Secrets are shown once. Dismissal, navigation, or changing the selected session clears them from the settings component.

## Remote workflow contract

The MCP initialization response includes short operating instructions. Refresh the
ChatGPT connection after deploying tool-schema, description, or instruction changes.
Validate the refreshed catalog in a new conversation; a source build does not update
an already-running session generation.

`load_context` includes active minor modes and returns public structured data along
with ordinary readable text. `load_extra_tools` discovers worktree capabilities
relative to the last parent catalog refresh. `search_skills` and `load_skill` remain
the supported way to discover and load current guidance. No companion plugin or
widget is required.
Repository instructions reflect the files loaded at session startup; reloading
context is not proof that newly edited instruction files were reloaded.

The remote bridge preserves declared tool annotations, output schemas, explicit
structured results, and MCP metadata. Internal renderer `details` are not exported.
Result-rewriting hooks invalidate the original structured payload and component
metadata so they cannot bypass a redaction.
Annotations describe side effects; the existing authenticated session remains the
authority for every call.

Remote `write_plan` requires a nonempty `markdown` argument and active Plan mode.
It saves the supplied text rather than attempting to read ChatGPT's transcript.
Use the existing `read` tool with the returned path to verify persistence. Saving
is not implementation approval. `complete_plan` requires the local DoomPi UI;
headless Fable planning is unavailable. Local transcript-based planning is unchanged.

A runner handle is not command completion. A runner started through remote `bash`
never wakes any agent when it ends, local or remote. The result says so and asks the
caller to check `doom-runner status <id>` and `doom-runner logs <id> --lines 100`
through Bash until State is completed. Remote `task` tracks work only (`upsert`, `list`,
`get`, `delete`, `clear`); delegation and the Team skill are not exposed remotely.
Host paths are not automatically downloadable ChatGPT attachments.

## Local agent lock

A session created for a remote conversation starts with its local agent locked. While
locked, the local agent starts no turns: web and CLI prompts, steer, follow-up, queue
promotion, queue drain, and extension prompts are refused, and model requests are
blocked. Remote MCP tool calls still run. Notices that arrive while locked, such as a
local runner finishing, are written to the transcript for the next turn instead of
starting one.

The composer shows `unlock agent` while locked. `lock agent` in the top bar locks any
session again and aborts a running local turn; a running remote call is never aborted.
The lock is saved with the session and survives restart, resume, revive, and dormancy.
It is not released when MCP disconnects. While unlocked, every remote tool result ends
with a notice that the local agent may also act, and `session_capabilities` reports
`localAgent: "unlocked"`.

## MCP Apps session widget

The remote-only `show_session` tool renders a read-only session summary in an MCP
Apps-compatible host. It shows the repository name, session ID, revision, profile,
domains, layers, and modes. It does not expose absolute repository paths,
instructions, persona text, credentials, or environment values. `load_context`
remains separate and does not open a widget. Text-only clients receive a readable
summary and the same structured data.

To try the widget after a source update:

1. Build the affected packages and relaunch the host and session with the updated
   composition. Refreshing a tool catalog alone does not reload the server bundle.
2. Refresh the MCP connection in the agent host. Restricted connections must grant
   `show_session`; existing grants that exclude it do not gain access automatically.
3. Invoke `show_session` in a new conversation. Confirm the session ID and selected
   modes, then click **Refresh** to update the existing component.

The browser component uses the standard MCP Apps SDK and the host's authenticated
`tools/call` bridge. It does not receive an access token or contact localhost,
DoomPi REST endpoints, or an external asset server. Other tools are advertised as
model-only unless their package explicitly permits component access. This UI
visibility policy does not replace server-side grants or authorization checks.

The HTML is embedded in the published Config MCP facet. Its resource URI is
`ui://doompi/session/<content-hash>/index.html`, with MIME type
`text/html;profile=mcp-app`. The tool's `_meta.ui.resourceUri` and optional OpenAI
compatibility alias identify the same resource. A changed template produces a new
URI, so the host cannot confuse it with cached bytes from an older build.

Static UI resources may be prefetched through an authorized connection without a
conversation ID. These reads never create a child session and cannot read skills
or other session-specific content. A resource is accessible only when an active,
granted tool references it, and authorization is checked again after loading.

Dynamic tool calls, including component refresh, still require the connection's
configured conversation correlation. A host that cannot preserve that metadata
must use a dedicated-session connection. DoomPi never silently redirects a missing
conversation ID to a shared session. The widget also hides its data if a refresh
returns a different session ID.

The repository tests cover protocol metadata, grants and revocation, conversation
isolation, installed-package resources, and a sandboxed browser host using the
standard SDK's `AppBridge`. Run the component tests with
`pnpm --filter @agimon-ai/doompi test:app`. Testing in
ChatGPT itself remains a separate integration check; a passing reference-host test
is not evidence that ChatGPT preserved conversation metadata.

This implementation serves DoomPi-authored UI resources. Forwarding arbitrary
upstream MCP Apps, public plugin submission, and configuring a production widget
origin are separate work. The existing authenticated MCP connection is sufficient
for developer testing; no companion plugin manifest is required.
