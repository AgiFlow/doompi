/**
 * Wire vocabulary for provider authentication, shared by the hub routes and
 * the settings page.
 *
 * The hub keeps one Pi ModelRuntime over the same auth.json the sessions
 * read, so a login here is a login for every session on this machine. Prompt
 * and event shapes restate pi-ai's AuthPrompt and AuthEvent so neither the
 * flow service nor the page needs a pi import; the abort signal never leaves
 * the hub.
 */

/** REST endpoint listing providers with their auth state; DELETE /:providerId signs out. */
export const AUTH_PROVIDERS_API_ROUTE = '/api/global/plugin/doompi/providers';

/** REST endpoint for login flows: POST starts one, GET /:flowId polls it, POST /:flowId/answer answers its prompt, DELETE /:flowId cancels. */
export const AUTH_LOGINS_API_ROUTE = '/api/global/plugin/doompi/logins';
