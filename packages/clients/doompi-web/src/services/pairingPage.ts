/**
 * The page a scanned QR opens, as one self-contained document.
 *
 * It cannot be the cockpit bundle. The bundle sits behind the guard, its hashed
 * asset URLs would each need allowlisting, and its first act is to open a
 * socket that would answer 401 in a reconnect loop. Keeping this to a single
 * document with no subresources is what holds the unauthenticated allowlist at
 * three exact paths instead of "any static file".
 *
 * Nothing from the request is echoed into the markup. The only dynamic value is
 * the nonce, so there is no injection point to reason about.
 */

import {
  PAIRING_CLAIM_ROUTE,
  PAIRING_STATUS_QUERY,
  PAIRING_STATUS_ROUTE,
  REMOTE_API_ROUTE,
} from '../types/remoteAccess.ts';

/** Asserted by the tunnel self-test to prove the pairing route is reachable end to end. */
export const PAIRING_PAGE_MARKER = 'doompi-pairing-page';

/** How often the phone asks whether the host has answered. */
const POLL_INTERVAL_MS = 1000;

export interface PairingPageInput {
  /** Per-response nonce; the CSP admits exactly this one inline script. */
  nonce: string;
}

export function pairingPageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function pairingPageHeaders(nonce: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': pairingPageCsp(nonce),
  };
}

/**
 * Colours are literals here rather than theme tokens on purpose: this page
 * renders before, and without, the cockpit bundle that defines the tokens, and
 * it lives outside `src/web` so the browser theming rule does not reach it.
 */
const STYLE = `
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #14161a; color: #e6e8ec;
    font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  main { width: min(30rem, 100% - 2.5rem); text-align: center; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.5rem; }
  p { margin: 0 0 1rem; color: #a2a8b4; }
  .state { font-weight: 600; color: #e6e8ec; }
  .bad { color: #ff6b6b; }
  .ok { color: #6bd68a; }
  form { display: flex; gap: 0.5rem; margin-top: 1.5rem; }
  input, button {
    font: inherit; padding: 0.6rem 0.8rem; border-radius: 0.5rem;
    border: 1px solid #2c313a; background: #1b1e24; color: inherit;
  }
  input { flex: 1; min-width: 0; }
  button { background: #2f6feb; border-color: #2f6feb; font-weight: 600; }
`;

/**
 * The client half of the pairing handshake.
 *
 * The code arrives in the URL fragment, which no browser sends to any server,
 * so it never reaches Cloudflare's edge logs, this process's access log, or a
 * Referer header. It is scrubbed from the address bar before anything else
 * runs, so a screenshot or a shared history entry does not carry it either.
 */
const SCRIPT = `
  const params = new URLSearchParams(location.hash.slice(1));
  const code = params.get('c') ?? '';
  // A QR supplies the key out of band. A successful passkey sign-in receives the
  // current public key from the trusted host after proving the credential.
  function rememberChannelKey(value) {
    if (typeof value !== 'string' || value === '') return false;
    try { sessionStorage.setItem('doompi.channelKey', value); return true; } catch { return false; }
  }
  rememberChannelKey(params.get('k'));
  history.replaceState(null, '', location.pathname);
  const state = document.getElementById('state');
  const manual = document.getElementById('manual');
  const say = (text, tone) => { state.textContent = text; state.className = 'state ' + (tone ?? ''); };

  async function poll(requestId) {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, ${String(POLL_INTERVAL_MS)}));
      const response = await fetch('${PAIRING_STATUS_ROUTE}?${PAIRING_STATUS_QUERY}=' + encodeURIComponent(requestId), {
        credentials: 'same-origin',
      });
      if (!response.ok) { say('This pairing request is no longer valid. Scan again.', 'bad'); return; }
      const body = await response.json();
      if (body.status === 'approved') { say('Paired. Opening the cockpit.', 'ok'); location.replace('/'); return; }
      if (body.status === 'denied') { say('The host denied this device.', 'bad'); return; }
      if (body.status === 'expired') { say('The request timed out. Scan again.', 'bad'); return; }
    }
  }

  async function claim(value) {
    if (value === '') { say('Scan the code shown on the host to pair.', 'bad'); manual.hidden = false; return; }
    say('Asking the host to approve this device...');
    const response = await fetch('${PAIRING_CLAIM_ROUTE}', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ code: value }),
    });
    if (!response.ok) {
      say(response.status === 429 ? 'Too many attempts. Wait a minute.' : 'That code is not valid. Scan again.', 'bad');
      manual.hidden = false;
      return;
    }
    const body = await response.json();
    say('Waiting for the host to approve this device.');
    await poll(body.requestId);
  }

  // A device that has enrolled a passkey should never need another code, so
  // this is offered before the scanned one is even read. The ceremony runs in
  // the page rather than through a bundle, because the bundle is behind the
  // guard this is trying to get past.
  async function passkeySignIn() {
    if (!window.PublicKeyCredential) return false;
    try {
      const begun = await fetch('${REMOTE_API_ROUTE}/passkeys/authenticate/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: '{}',
      });
      if (!begun.ok) return false;
      const { ceremonyId, options } = await begun.json();
      if (typeof ceremonyId !== 'string') return false;
      const credential = await navigator.credentials.get({ publicKey: decodeOptions(options) });
      if (!credential) return false;
      const finished = await fetch('${REMOTE_API_ROUTE}/passkeys/authenticate/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ ceremonyId, response: encodeCredential(credential) }),
      });
      if (!finished.ok) return false;
      const result = await finished.json();
      return rememberChannelKey(result.hostPublicKey);
    } catch {
      return false;
    }
  }

  const fromBase64Url = (value) =>
    Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
  const toBase64Url = (buffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

  function decodeOptions(options) {
    return {
      ...options,
      challenge: fromBase64Url(options.challenge),
      allowCredentials: (options.allowCredentials ?? []).map((entry) => ({
        ...entry,
        id: fromBase64Url(entry.id),
      })),
    };
  }

  function encodeCredential(credential) {
    const assertion = credential.response;
    return {
      id: credential.id,
      rawId: toBase64Url(credential.rawId),
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: toBase64Url(assertion.clientDataJSON),
        authenticatorData: toBase64Url(assertion.authenticatorData),
        signature: toBase64Url(assertion.signature),
        userHandle: assertion.userHandle ? toBase64Url(assertion.userHandle) : undefined,
      },
    };
  }

  manual.addEventListener('submit', (event) => {
    event.preventDefault();
    manual.hidden = true;
    void claim(new FormData(manual).get('code')?.toString().trim() ?? '');
  });

  void (async () => {
    say('Checking for a passkey on this device...');
    if (await passkeySignIn()) { say('Signed in. Opening the cockpit.', 'ok'); location.replace('/'); return; }
    await claim(code);
  })();
`;

export function pairingPageHtml(input: PairingPageInput): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Pair with DoomPi</title>
<style>${STYLE}</style>
</head>
<body data-marker="${PAIRING_PAGE_MARKER}">
<main>
  <h1>Pair this device</h1>
  <p>This cockpit can run shell commands on the host machine. Pair only your own device.</p>
  <p id="state" class="state">Starting.</p>
  <form id="manual" hidden>
    <input name="code" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Pairing code">
    <button type="submit">Pair</button>
  </form>
  <noscript><p class="bad">Pairing needs JavaScript, because the code never leaves your browser.</p></noscript>
</main>
<script nonce="${input.nonce}">${SCRIPT}</script>
</body>
</html>`;
}
