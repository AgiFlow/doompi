# Session MCP

DoomPi Web can expose one live DoomPi session as a remote MCP server. Remote Control supplies the public HTTPS origin, and the session MCP endpoint follows the session's active tools and skills.

This is an inbound connection. It is separate from outbound MCP servers, remote pairing, and Remote Control.

## Connect ChatGPT

1. Start the session and enable Remote Control with a public HTTPS origin.
2. Open **Settings → Remote control → session MCP**.
3. Copy the displayed **MCP URL**.
4. In ChatGPT, add a custom connector and choose **User-Defined OAuth Client**.
5. Copy ChatGPT's exact **Callback URL** and paste it into DoomPi Web. DoomPi cannot generate this callback URL.
6. Create the OAuth client, then copy the MCP URL, client ID, and one-time client secret into ChatGPT.
7. In ChatGPT, select **`client_secret_post`** as the token endpoint authentication method, not `none`.
8. Complete the OAuth connection and verify the available tools and skill resources.

The client name is generated from the trusted Remote Control domain. The callback must be the exact absolute HTTPS URL supplied by ChatGPT. It is not safe to derive one from the DoomPi domain.

Access follows the session's current major mode, minor modes, domains, and profile, including later changes. Session tools run with the session process's permissions. Granting shell access can reach the filesystem, environment, network, and operating system privileges available to that session. OAuth is not a sandbox.

## OAuth policy

Session MCP uses confidential clients created by the host owner. Public Dynamic Client Registration and Client Identifier Metadata Documents are not supported. Unknown or URL-shaped client IDs are not resolved over the network.

The flow requires an exact registered HTTPS callback, authorization code exchange with S256 PKCE, and `client_secret_post`. Client credentials identify the connector and do not widen the session scope. Access tokens are bound to the exact MCP resource, client, live session incarnation, and session scope.

Client creation is host-only. A paired remote browser or connector credential cannot create a client. Public tunnel routes expose only OAuth discovery, authorization, token exchange, and the Bearer-protected MCP endpoint.

## Lifetime and revocation

Clients, grants, and tokens are process-local. Ending or restarting the session, restarting the host, disabling Remote Control, changing the public origin, or revoking the client invalidates access. Create a new client after those changes.

The secret is shown once. Dismissal, navigation, or changing the selected session clears it from the settings component.
