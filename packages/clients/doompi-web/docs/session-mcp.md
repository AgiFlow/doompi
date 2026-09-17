# Session MCP

DoomPi Web can expose the active tools and skills of one live DoomPi session as a remote MCP server. The session remains owned by the headless process. DoomPi Web proxies the endpoint and Remote Control supplies its public HTTPS origin.

This is an inbound connection. It is separate from the outbound MCP servers listed in the session Context panel.

## Create a ChatGPT client

1. Start the session you want to expose and enable Remote Control so it has a public HTTPS URL.
2. In ChatGPT, start adding a custom MCP connector, select **User-Defined OAuth Client**, and copy the callback URL that ChatGPT displays.
3. On the machine running DoomPi Web, open **Settings → Remote control → session MCP clients**.
4. Select the live session, enter a client name, and paste the exact ChatGPT HTTPS callback URL.
5. Select only the tools and skills that connector should receive. Selecting `bash` grants shell access with the DoomPi session process's filesystem, environment, network, and operating-system privileges.
6. Create the client. Copy the MCP URL, client ID, and one-time client secret into ChatGPT. Select `client_secret_post` as the token endpoint authentication method.
7. Complete ChatGPT's OAuth connection and verify the listed tools and skill resources before using them.

The secret is shown once. It is not stored in browser persistence or returned by later client listings. Dismissal, navigation, or changing the selected session clears it from the settings component.

## OAuth policy

Session MCP uses confidential clients created by the host owner. Public Dynamic Client Registration and Client Identifier Metadata Documents are not supported. Unknown or URL-shaped client IDs are not resolved over the network.

The flow requires an exact registered HTTPS callback, authorization code exchange with S256 PKCE, and `client_secret_post`. Client credentials identify the connector; they do not widen the tools and skills selected by the host owner. Access tokens are bound to the exact MCP resource, client, live session incarnation, and approved capabilities.

Client creation is host-only. A paired remote browser or connector credential cannot create a client. Public tunnel routes expose only OAuth discovery, authorization, token exchange, and the Bearer-protected MCP endpoint.

## Lifetime and revocation

Clients, grants, and tokens are process-local. Ending or restarting the session, restarting the host, disabling Remote Control, changing the public origin, or revoking the client invalidates access. Create a new client after those changes.

Revocation blocks future operations and attempts to stop work owned by that client. It cannot reverse filesystem changes, network requests, or other side effects that already completed.

## Security limits

An exported tool runs in the same session context as DoomPi. OAuth authenticates and limits the named capabilities, but it is not a sandbox. In particular, a granted shell can perform operations beyond the apparent names of other allowlisted tools. Use DoomPi's container boundary when the connector must not reach the rest of the host.

The manual client fields are present in ChatGPT, but end-to-end compatibility with its current `client_secret_post`, Streamable HTTP, and MCP resource behavior has not been independently verified for this release. Do not weaken authentication to `none` if a client cannot connect.
