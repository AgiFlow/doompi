import { describe, expect, it } from 'vitest';
import {
  PAIRING_PAGE_MARKER,
  pairingPageCsp,
  pairingPageHeaders,
  pairingPageHtml,
} from '../../src/services/pairingPage.ts';

const NONCE = 'test-nonce-value';

describe('the pairing page', () => {
  it('carries the marker the tunnel self-test looks for', () => {
    expect(pairingPageHtml({ nonce: NONCE })).toContain(PAIRING_PAGE_MARKER);
  });

  it('loads only the exact package-owned PWA bootstrap resources', () => {
    const html = pairingPageHtml({ nonce: NONCE });
    expect(html.match(/<link\b/gu)).toHaveLength(1);
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html.match(/<script[^>]+\bsrc=/gu)).toHaveLength(1);
    expect(html).toContain('<script type="module" src="/pwa/pwa.js"></script>');
    expect(html).not.toMatch(/<img\b/u);
    expect(html).not.toMatch(/@import/u);
  });

  it('admits the nonce script and package-owned scripts only', () => {
    const html = pairingPageHtml({ nonce: NONCE });
    expect(html).toContain(`<script nonce="${NONCE}">`);
    expect(pairingPageCsp(NONCE)).toContain(`script-src 'nonce-${NONCE}' 'self'`);
    expect(pairingPageCsp(NONCE)).toContain("manifest-src 'self'");
    expect(pairingPageCsp(NONCE)).toContain("worker-src 'self'");
  });

  it('denies everything by default and forbids being framed', () => {
    const csp = pairingPageCsp(NONCE);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  it('reads initial and in-page scanned codes from the fragment before scrubbing it', () => {
    // A fragment is never sent to any server, so the code stays out of the
    // edge's logs, this process's log, and any Referer.
    const html = pairingPageHtml({ nonce: NONCE });
    expect(html).toContain('location.hash');
    expect(html).toContain("window.addEventListener('hashchange'");
    expect(html).toContain('void claim(nextCode, nextTrust)');
    expect(html).toContain('if (!fragmentClaimStarted)');
    expect(html).toContain('history.replaceState');
    expect(html).not.toContain('location.search');
  });

  it('stores the fresh host key returned by a passkey sign-in', () => {
    const html = pairingPageHtml({ nonce: NONCE });
    expect(html).toContain('rememberChannelKey(result.hostPublicKey)');
    expect(html).toContain("sessionStorage.setItem('doompi.channelKey', value)");
  });

  it('offers approved phones a passkey before opening the cockpit', () => {
    const html = pairingPageHtml({ nonce: NONCE });
    expect(html).toContain('Add a passkey to use Face ID, Touch ID, or your device PIN next time.');
    expect(html).toContain('id="add-passkey"');
    expect(html).toContain('id="skip-passkey"');
    expect(html).toContain("fetch('/api/remote/passkeys/register/begin'");
    expect(html).toContain("fetch('/api/remote/passkeys/register/finish'");
  });

  it('keeps inactive manual and passkey controls hidden', () => {
    const html = pairingPageHtml({ nonce: NONCE });
    expect(html).toContain('[hidden] { display: none !important; }');
    expect(html).toContain('<form id="manual" hidden>');
    expect(html).toContain('<div id="actions" class="actions" hidden>');
  });

  it('accepts an eight-digit code for manual entry', () => {
    const html = pairingPageHtml({ nonce: NONCE });
    expect(html).toContain('inputmode="numeric"');
    expect(html).toContain('pattern="[0-9]{8}"');
    expect(html).toContain('maxlength="8"');
  });

  it('continues when the device reports that the passkey already exists', () => {
    const html = pairingPageHtml({ nonce: NONCE });
    expect(html).toContain("error?.name === 'InvalidStateError'");
    expect(html).toContain('A passkey for this site already exists. Opening the cockpit.');
  });
  it('claims a scanned code before trying passkey sign-in', () => {
    const html = pairingPageHtml({ nonce: NONCE });
    expect(html).toContain("if (code !== '') { await claim(code, scannedTrust); return; }");
  });

  it('pins and verifies the QR signer before opening the cockpit', () => {
    const html = pairingPageHtml({ nonce: NONCE });
    expect(html).toContain("params.get('s')");
    expect(html).toContain("params.get('r')");
    expect(html).toContain("type: 'doompi:activate-bundle'");
    expect(html).toContain("type: 'doompi:reset-bundle-trust'");
    expect(html).toContain('Compare this signing-key fingerprint');
  });

  it('warns rather than silently failing without JavaScript', () => {
    expect(pairingPageHtml({ nonce: NONCE })).toContain('<noscript>');
  });

  it('says what pairing actually grants', () => {
    expect(pairingPageHtml({ nonce: NONCE })).toContain('run shell commands');
  });

  it('is never cached and never leaks a referrer', () => {
    const headers = pairingPageHeaders(NONCE);
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['X-Frame-Options']).toBe('DENY');
  });
});
