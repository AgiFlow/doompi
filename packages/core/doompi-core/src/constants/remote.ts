/**
 * Wire vocabulary for remote access, shared by the hub routes and the cockpit.
 *
 * Remote access binds a second loopback listener that a tunnel points at, and
 * everything arriving there must prove it holds a paired session. The
 * discriminator is the listening socket, not a header: a tunnel connects from
 * 127.0.0.1 like every local client, and there is no header a remote caller
 * cannot forge.
 */

/** REST surface for the remote-access control plane; local callers only, except turn-off and revoke. */
export const REMOTE_API_ROUTE = '/api/remote';

/** Direct endpoint that establishes one scoped end-to-end channel. */
export const REMOTE_CHANNEL_ROUTE = `${REMOTE_API_ROUTE}/channel`;

/** The only authenticated HTTP gateway exposed on the tunnel listener. */
export const REMOTE_HTTP_ROUTE = `${REMOTE_API_ROUTE}/request`;

/** Device-bound, sealed routes for ephemeral live Web Push registration. */
export const REMOTE_PUSH_ROUTE = `${REMOTE_API_ROUTE}/push`;

export const REMOTE_PUSH_KEY_ROUTE = `${REMOTE_PUSH_ROUTE}/key`;

export const PROTOCOL_SOCKET_ROUTE = '/api/pi';

/** The pairing page a scanned QR opens. Unauthenticated on the tunnel listener. */
export const PAIRING_PAGE_ROUTE = '/pair';

/** Where the pairing page posts the scanned code. Unauthenticated on the tunnel listener. */
export const PAIRING_CLAIM_ROUTE = '/api/remote/pair';

/** Polled until the host approves or denies. Unauthenticated on the tunnel listener. */
export const PAIRING_STATUS_ROUTE = '/api/remote/pair/status';

/** Query parameter naming the pairing request; a path parameter would force a wildcard into the allowlist. */
export const PAIRING_STATUS_QUERY = 'request';

/** URL-fragment fields authenticated by seeing the host's physical QR. */
export const BUNDLE_SIGNING_KEY_PARAM = 's';

export const BUNDLE_MINIMUM_REVISION_PARAM = 'r';

/**
 * Session cookie base name. Rendered `__Host-doompi_device` by hono's `host`
 * prefix, which refuses the cookie unless it is Secure, Path=/, and
 * Domain-less, so a sibling subdomain can neither read nor overwrite it.
 */
export const DEVICE_COOKIE = 'doompi_device';

/**
 * Passkey ceremonies exposed directly on the pairing surface.
 *
 * Sign-in is unauthenticated because it creates a session. Registration requires
 * the paired device cookie issued after host approval, but remains direct so the
 * self-contained pairing page can offer enrolment before loading the cockpit.
 */
export const PASSKEY_AUTH_BEGIN_ROUTE = '/api/remote/passkeys/authenticate/begin';

export const PASSKEY_AUTH_FINISH_ROUTE = '/api/remote/passkeys/authenticate/finish';

export const PASSKEY_REGISTER_BEGIN_ROUTE = '/api/remote/passkeys/register/begin';

export const PASSKEY_REGISTER_FINISH_ROUTE = '/api/remote/passkeys/register/finish';

/** Header carrying a step-up assertion for an action that needs more than a live session. */
export const STEP_UP_HEADER = 'x-doompi-assertion';

/** The vite dev server port; the origin allowlist and vite.config.ts share this. */
export const WEB_DEV_SERVER_PORT = 7434;

/** How long a scanned pairing code stays claimable. */
export const PAIRING_CODE_TTL_MS = 120_000;

/** How long the host has to approve or deny a claimed request. */
export const PAIRING_REQUEST_TTL_MS = 180_000;

/** Cookie lifetime when session expiry is switched off; a session cookie can outlive the laptop. */
export const COOKIE_CEILING_SECONDS = 2_592_000;

/** Hub frame announcing remote-access state; sent to local and remote pages. */
export const REMOTE_STATE_TYPE = 'remote_state';

/** Hub frame announcing a device waiting for approval; sent to local pages only. */
export const REMOTE_PAIRING_REQUEST_TYPE = 'remote_pairing_request';
