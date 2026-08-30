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

  it('pulls in no subresources at all', () => {
    // What keeps the unauthenticated allowlist at three exact paths: allowing a
    // whole asset directory is how such a list rots into a bypass.
    const html = pairingPageHtml({ nonce: NONCE });
    expect(html).not.toMatch(/<link\b/u);
    expect(html).not.toMatch(/<script[^>]+\bsrc=/u);
    expect(html).not.toMatch(/<img\b/u);
    expect(html).not.toMatch(/@import/u);
  });

  it('admits exactly the one inline script, by nonce', () => {
    const html = pairingPageHtml({ nonce: NONCE });
    expect(html).toContain(`<script nonce="${NONCE}">`);
    expect(pairingPageCsp(NONCE)).toContain(`script-src 'nonce-${NONCE}'`);
  });

  it('denies everything by default and forbids being framed', () => {
    const csp = pairingPageCsp(NONCE);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  it('reads the code from the fragment and scrubs it', () => {
    // A fragment is never sent to any server, so the code stays out of the
    // edge's logs, this process's log, and any Referer.
    const html = pairingPageHtml({ nonce: NONCE });
    expect(html).toContain('location.hash');
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
    expect(html).toContain("if (code !== '') { await claim(code); return; }");
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
