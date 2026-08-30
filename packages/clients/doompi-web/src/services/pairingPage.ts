/**
 * The package-owned page a scanned QR opens before any cockpit JavaScript runs.
 *
 * It cannot be the cockpit bundle. The bundle sits behind the guard and must be
 * verified first. Its only subresource is the separately built package-owned PWA
 * bootstrap, whose worker verifies and stages the signed host bundle.
 *
 * Request data is never echoed into the markup. Local-loopback responses may embed
 * the package-generated public signer fields, whose alphabets cannot form markup.
 */

import {
  BUNDLE_MINIMUM_REVISION_PARAM,
  BUNDLE_SIGNING_KEY_PARAM,
  PAIRING_CLAIM_ROUTE,
  PAIRING_STATUS_QUERY,
  PAIRING_STATUS_ROUTE,
  PASSKEY_REGISTER_BEGIN_ROUTE,
  PASSKEY_REGISTER_FINISH_ROUTE,
  REMOTE_API_ROUTE,
  type BundlePairingTrust,
} from '../types/remoteAccess.ts';

/** Asserted by the tunnel self-test to prove the pairing route is reachable end to end. */
export const PAIRING_PAGE_MARKER = 'doompi-pairing-page';

/** How often the phone asks whether the host has answered. */
const POLL_INTERVAL_MS = 1000;

export interface PairingPageInput {
  /** Per-response nonce; the CSP admits exactly this one inline script. */
  nonce: string;
  /** Local-loopback bootstrap trust. Remote callers must bring it in the QR fragment. */
  localTrust?: BundlePairingTrust;
}

export function pairingPageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}' 'self'`,
    "connect-src 'self'",
    "img-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
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
  [hidden] { display: none !important; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.5rem; }
  p { margin: 0 0 1rem; color: #a2a8b4; }
  .state { font-weight: 600; color: #e6e8ec; }
  .bad { color: #ff6b6b; }
  .ok { color: #6bd68a; }
  form, .actions { display: flex; gap: 0.5rem; margin-top: 1.5rem; }
  input, button {
    font: inherit; padding: 0.6rem 0.8rem; border-radius: 0.5rem;
    border: 1px solid #2c313a; background: #1b1e24; color: inherit;
  }
  input { flex: 1; min-width: 0; }
  button { flex: 1; background: #2f6feb; border-color: #2f6feb; font-weight: 600; }
  button.secondary { background: #1b1e24; border-color: #2c313a; }
  button:disabled { opacity: 0.6; }
  video { width: 100%; max-height: 18rem; border-radius: 0.75rem; margin-top: 1rem; }
  code { display: block; overflow-wrap: anywhere; margin: 0.75rem 0; color: #e6e8ec; }
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
  const state = document.getElementById('state');
  const manual = document.getElementById('manual');
  const actions = document.getElementById('actions');
  const addPasskey = document.getElementById('add-passkey');
  const skipPasskey = document.getElementById('skip-passkey');
  const trustPanel = document.getElementById('trust');
  const trustFingerprint = document.getElementById('trust-fingerprint');
  const acceptTrust = document.getElementById('accept-trust');
  const say = (text, tone) => { state.textContent = text; state.className = 'state ' + (tone ?? ''); };
  const openCockpit = () => location.replace('/');

  function trustOf(value) {
    if (!value || typeof value.publicKey !== 'string' || !/^[A-Za-z0-9_-]{80,512}$/.test(value.publicKey)) return undefined;
    const revision = Number(value.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) return undefined;
    return { publicKey: value.publicKey, revision, fingerprint: typeof value.fingerprint === 'string' ? value.fingerprint : '' };
  }

  const scannedTrust = trustOf({
    publicKey: params.get('${BUNDLE_SIGNING_KEY_PARAM}'),
    revision: params.get('${BUNDLE_MINIMUM_REVISION_PARAM}'),
  });
  let fragmentClaimStarted = code !== '';
  const localTrust = trustOf({
    publicKey: document.body.dataset.localSigner,
    revision: document.body.dataset.localRevision,
    fingerprint: document.body.dataset.localFingerprint,
  });

  function rememberChannelKey(value) {
    if (typeof value !== 'string' || value === '') return false;
    try { sessionStorage.setItem('doompi.channelKey', value); return true; } catch { return false; }
  }
  rememberChannelKey(params.get('k'));
  history.replaceState(null, '', location.pathname);
  window.addEventListener('hashchange', () => {
    const nextParams = new URLSearchParams(location.hash.slice(1));
    const nextCode = nextParams.get('c') ?? '';
    if (nextCode === '') return;
    fragmentClaimStarted = true;
    const nextTrust = trustOf({
      publicKey: nextParams.get('${BUNDLE_SIGNING_KEY_PARAM}'),
      revision: nextParams.get('${BUNDLE_MINIMUM_REVISION_PARAM}'),
    });
    rememberChannelKey(nextParams.get('k'));
    history.replaceState(null, '', location.pathname);
    void claim(nextCode, nextTrust);
  });

  async function requestWorker(message) {
    if (!('serviceWorker' in navigator)) return { ok: false, message: 'This browser cannot install the trusted verifier.' };
    let registration;
    try {
      registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error('The trusted verifier did not start.')), 20000)),
      ]);
    } catch (error) {
      return { ok: false, message: error?.message ?? 'The trusted verifier did not start.' };
    }
    const serviceWorker = registration.active ?? registration.waiting ?? registration.installing;
    if (!serviceWorker) return { ok: false, message: 'The trusted verifier is unavailable.' };
    const channel = new MessageChannel();
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, message: 'Bundle verification timed out.' }), 120000);
      channel.port1.addEventListener('message', (event) => {
        clearTimeout(timer);
        resolve(event.data && typeof event.data.ok === 'boolean' ? event.data : { ok: false, message: 'The verifier returned invalid data.' });
      }, { once: true });
      channel.port1.start();
      serviceWorker.postMessage(message, [channel.port2]);
    });
  }

  async function activateTrust(trust, alreadyConfirmed = false) {
    say('Verifying every cockpit file before it can run.');
    let result = await requestWorker({ type: 'doompi:activate-bundle', publicKey: trust.publicKey, minimumRevision: trust.revision });
    if (!result.ok && result.code === 'signer-mismatch') {
      if (!alreadyConfirmed && !(await confirmManualTrust(trust))) return false;
      say('Resetting the old host key and verifying the newly paired host.');
      const reset = await requestWorker({ type: 'doompi:reset-bundle-trust' });
      if (!reset.ok) { say(reset.message ?? 'The old host key could not be reset.', 'bad'); return false; }
      result = await requestWorker({ type: 'doompi:activate-bundle', publicKey: trust.publicKey, minimumRevision: trust.revision });
    }
    if (!result.ok) {
      say(result.message ?? 'The signed cockpit bundle was refused.', 'bad');
      return false;
    }
    return true;
  }

  function offerPasskey() {
    if (!window.PublicKeyCredential) {
      say('Paired and verified. Opening the cockpit.', 'ok');
      setTimeout(openCockpit, ${String(POLL_INTERVAL_MS)});
      return;
    }
    say('Paired and verified. Add a passkey to use Face ID, Touch ID, or your device PIN next time.', 'ok');
    actions.hidden = false;
  }

  async function signingFingerprint(publicKey) {
    try {
      const normalized = publicKey.replaceAll('-', '+').replaceAll('_', '/');
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
      const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      return 'unavailable';
    }
  }

  async function confirmManualTrust(trust) {
    const fingerprint = trust.fingerprint || await signingFingerprint(trust.publicKey);
    return await new Promise((resolve) => {
      trustFingerprint.textContent = fingerprint.match(/.{1,8}/g)?.join(' ') ?? fingerprint;
      trustPanel.hidden = false;
      say('Compare this signing-key fingerprint with the one shown on the host.');
      acceptTrust.addEventListener('click', () => { trustPanel.hidden = true; resolve(true); }, { once: true });
    });
  }

  async function poll(requestId) {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, ${String(POLL_INTERVAL_MS)}));
      const response = await fetch('${PAIRING_STATUS_ROUTE}?${PAIRING_STATUS_QUERY}=' + encodeURIComponent(requestId), { credentials: 'same-origin' });
      if (!response.ok) { say('This pairing request is no longer valid. Scan again.', 'bad'); return undefined; }
      const body = await response.json();
      if (body.status === 'approved') return body;
      if (body.status === 'denied') { say('The host denied this device.', 'bad'); return undefined; }
      if (body.status === 'expired') { say('The request timed out. Scan again.', 'bad'); return undefined; }
    }
  }

  async function claim(value, candidateTrust) {
    if (value === '') { say('Scan the code shown on the host or enter its manual code.', 'bad'); manual.hidden = false; return; }
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
    const claimed = await response.json();
    say('Waiting for the host to approve this device.');
    const approved = await poll(claimed.requestId);
    if (!approved) return;
    rememberChannelKey(approved.hostPublicKey);
    const trust = candidateTrust ?? trustOf(approved.bundleTrust);
    if (!trust) { say('The host did not provide signed-bundle trust. Pair again.', 'bad'); return; }
    if (!candidateTrust && !(await confirmManualTrust(trust))) return;
    if (await activateTrust(trust, !candidateTrust)) offerPasskey();
  }

  const fromBase64Url = (value) =>
    Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
  const toBase64Url = (buffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

  function decodeAuthenticationOptions(options) {
    return {
      ...options,
      challenge: fromBase64Url(options.challenge),
      allowCredentials: (options.allowCredentials ?? []).map((entry) => ({ ...entry, id: fromBase64Url(entry.id) })),
    };
  }

  function decodeRegistrationOptions(options) {
    return {
      ...options,
      challenge: fromBase64Url(options.challenge),
      user: { ...options.user, id: fromBase64Url(options.user.id) },
      excludeCredentials: (options.excludeCredentials ?? []).map((entry) => ({ ...entry, id: fromBase64Url(entry.id) })),
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

  function encodeRegistrationCredential(credential) {
    const attestation = credential.response;
    return {
      id: credential.id,
      rawId: toBase64Url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: toBase64Url(attestation.clientDataJSON),
        attestationObject: toBase64Url(attestation.attestationObject),
        transports: typeof attestation.getTransports === 'function' ? attestation.getTransports() : [],
      },
    };
  }

  async function passkeySignIn() {
    if (!window.PublicKeyCredential) return false;
    try {
      const begun = await fetch('${REMOTE_API_ROUTE}/passkeys/authenticate/begin', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: '{}',
      });
      if (!begun.ok) return false;
      const { ceremonyId, options } = await begun.json();
      if (typeof ceremonyId !== 'string') return false;
      const credential = await navigator.credentials.get({ publicKey: decodeAuthenticationOptions(options) });
      if (!credential) return false;
      const finished = await fetch('${REMOTE_API_ROUTE}/passkeys/authenticate/finish', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ ceremonyId, response: encodeCredential(credential) }),
      });
      if (!finished.ok) return false;
      const result = await finished.json();
      if (!rememberChannelKey(result.hostPublicKey)) return false;
      const refreshed = await requestWorker({ type: 'doompi:refresh-bundle' });
      return refreshed.ok;
    } catch {
      return false;
    }
  }

  async function registerPasskey() {
    addPasskey.disabled = true;
    skipPasskey.disabled = true;
    say('Confirm passkey setup on this device.');
    try {
      const begun = await fetch('${PASSKEY_REGISTER_BEGIN_ROUTE}', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: '{}',
      });
      if (!begun.ok) throw new Error('Passkey setup is unavailable.');
      const { ceremonyId, options } = await begun.json();
      if (typeof ceremonyId !== 'string') throw new Error('Passkey setup is unavailable.');
      const credential = await navigator.credentials.create({ publicKey: decodeRegistrationOptions(options) });
      if (!credential) throw new Error('Passkey setup was cancelled.');
      const finished = await fetch('${PASSKEY_REGISTER_FINISH_ROUTE}', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ ceremonyId, response: encodeRegistrationCredential(credential) }),
      });
      if (!finished.ok) throw new Error('That passkey was not accepted.');
      say('Passkey added. Opening the cockpit.', 'ok');
      setTimeout(openCockpit, ${String(POLL_INTERVAL_MS)});
    } catch (error) {
      if (error?.name === 'InvalidStateError') {
        say('A passkey for this site already exists. Opening the cockpit.', 'ok');
        setTimeout(openCockpit, ${String(POLL_INTERVAL_MS)});
        return;
      }
      say(error?.name === 'NotAllowedError' ? 'Passkey setup was cancelled.' : (error?.message ?? 'Passkey setup failed.'), 'bad');
      addPasskey.disabled = false;
      skipPasskey.disabled = false;
    }
  }

  manual.addEventListener('submit', (event) => {
    event.preventDefault();
    manual.hidden = true;
    void claim(new FormData(manual).get('code')?.toString().trim() ?? '', undefined);
  });
  addPasskey.addEventListener('click', () => void registerPasskey());
  skipPasskey.addEventListener('click', openCockpit);

  void (async () => {
    if (localTrust) {
      if (await activateTrust(localTrust)) openCockpit();
      return;
    }
    if (code !== '') { await claim(code, scannedTrust); return; }
    say('Checking for a passkey on this device...');
    if (await passkeySignIn()) { say('Signed in and verified. Opening the cockpit.', 'ok'); openCockpit(); return; }
    if (!fragmentClaimStarted) await claim('', undefined);
  })();
`;

export function pairingPageHtml(input: PairingPageInput): string {
  const localSigner = input.localTrust?.publicKey ?? '';
  const localRevision = input.localTrust?.revision ?? '';
  const localFingerprint = input.localTrust?.fingerprint ?? '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#14161a">
<link rel="manifest" href="/manifest.webmanifest">
<title>Pair with DoomPi</title>
<style>${STYLE}</style>
</head>
<body data-marker="${PAIRING_PAGE_MARKER}" data-local-signer="${localSigner}" data-local-revision="${String(localRevision)}" data-local-fingerprint="${localFingerprint}">
<main>
  <h1>Pair this device</h1>
  <p>This cockpit can run shell commands on the host machine. Pair only your own device.</p>
  <p id="state" class="state">Starting.</p>
  <form id="manual" hidden>
    <input name="code" inputmode="numeric" pattern="[0-9]{8}" maxlength="8" autocomplete="one-time-code" placeholder="8-digit pairing code" aria-label="8-digit pairing code">
    <button type="submit">Pair</button>
  </form>
  <div id="trust" hidden>
    <p>Signing-key fingerprint</p>
    <code id="trust-fingerprint"></code>
    <button id="accept-trust" type="button">Fingerprint matches</button>
  </div>
  <div id="actions" class="actions" hidden>
    <button id="add-passkey" type="button">Add passkey</button>
    <button id="skip-passkey" class="secondary" type="button">Not now</button>
  </div>
  <section id="scanner">
    <p id="pwa-status" role="status">Checking browser support.</p>
    <video id="camera" playsinline muted hidden></video>
    <div class="actions">
      <button id="scan" type="button">Scan pairing QR</button>
      <button id="cancel" class="secondary" type="button" hidden>Cancel</button>
    </div>
  </section>
  <noscript><p class="bad">Pairing needs JavaScript, because the code never leaves your browser.</p></noscript>
</main>
<script nonce="${input.nonce}">${SCRIPT}</script>
<script type="module" src="/pwa/pwa.js"></script>
</body>
</html>`;
}
