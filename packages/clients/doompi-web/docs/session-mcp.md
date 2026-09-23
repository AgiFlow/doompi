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

## Skills

Remote clients can use `search_skills` to discover repository and active-domain skills, then `load_skill` with an exact skill name to retrieve its Markdown. Both tools see only skills granted to the connection. Existing skill resources remain available for clients that support MCP resources.
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
with ordinary readable text. `search_skills` and `load_skill` remain the supported
way to discover and load current guidance. No companion plugin or widget is required.
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

A runner handle is not command completion. Use bounded `doom-runner status` and
`doom-runner logs --lines` calls through Bash to retrieve the existing run's result.
Do not assume that background notifications resume a remote conversation, and do
not launch background delegation without a demonstrated result-delivery path.
Host paths are not automatically downloadable ChatGPT attachments.

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
`pnpm --filter @agimon-ai/doompi-config test:app` after building Config. Testing in
ChatGPT itself remains a separate integration check; a passing reference-host test
is not evidence that ChatGPT preserved conversation metadata.

This implementation serves DoomPi-authored UI resources. Forwarding arbitrary
upstream MCP Apps, public plugin submission, and configuring a production widget
origin are separate work. The existing authenticated MCP connection is sufficient
for developer testing; no companion plugin manifest is required.
