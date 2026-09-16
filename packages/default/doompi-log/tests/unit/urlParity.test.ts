import { describe, expect, it } from 'vitest';

import { api } from '../../generated/client';

/**
 * Pins every URL this package sends, as a literal string.
 *
 * These were captured from the hand-written `metricsUrl` and `issuesUrl`
 * builders before they were deleted, by running this file against both, so they
 * are the shapes the cockpit has always sent rather than the shapes the current
 * code happens to produce. Keeping them literal is the point: a mistyped mount
 * is not reported by the route it misses, because the service worker answers
 * any unrecognised path out of the signed bundle cache, and the page reads the
 * SPA shell it gets back as "the log API is not installed".
 *
 * One difference from the old builders is deliberate. A space is `%20` rather
 * than the `+` that `URLSearchParams` wrote; `+` decodes back to a space only
 * under form-urlencoded rules, and Hono's query parser reads both, so the two
 * name the same focus.
 */

const MOUNT = '/api/plugins/log';
const scoped = api.global;

describe('the URLs this package sends', () => {
  it('reads one report, dimension then period', () => {
    expect(scoped.metrics.url({ query: { dimension: 'model', period: 'week' } })).toBe(
      `${MOUNT}/metrics?dimension=model&period=week`,
    );
    expect(scoped.metrics.url({ query: { dimension: 'session', period: 'day' } })).toBe(
      `${MOUNT}/metrics?dimension=session&period=day`,
    );
    expect(scoped.metrics.url({ query: { dimension: 'provider', period: 'all' } })).toBe(
      `${MOUNT}/metrics?dimension=provider&period=all`,
    );
  });

  it('narrows a report to one group', () => {
    expect(scoped.metrics.url({ query: { dimension: 'model', period: 'week', focus: 'claude-sonnet-4-5' } })).toBe(
      `${MOUNT}/metrics?dimension=model&period=week&focus=claude-sonnet-4-5`,
    );
  });

  it('drops an absent focus rather than sending a blank filter', () => {
    expect(scoped.metrics.url({ query: { dimension: 'model', period: 'week', focus: undefined } })).toBe(
      `${MOUNT}/metrics?dimension=model&period=week`,
    );
  });

  it('reads the issue detail, which carries no query when unfocused', () => {
    expect(scoped.issues.url()).toBe(`${MOUNT}/issues`);
    expect(scoped.issues.url({ query: { focus: undefined } })).toBe(`${MOUNT}/issues`);
    expect(scoped.issues.url({ query: { focus: 'id_abc' } })).toBe(`${MOUNT}/issues?focus=id_abc`);
  });

  it('escapes a space as %20, where the old builder wrote +', () => {
    expect(scoped.metrics.url({ query: { dimension: 'model', period: 'week', focus: 'a b' } })).toBe(
      `${MOUNT}/metrics?dimension=model&period=week&focus=a%20b`,
    );
    expect(scoped.issues.url({ query: { focus: 'a b#c&d/e' } })).toBe(`${MOUNT}/issues?focus=a%20b%23c%26d%2Fe`);
  });

  it('reads both routes with GET', () => {
    expect(scoped.metrics.spec.method).toBe('GET');
    expect(scoped.issues.spec.method).toBe('GET');
  });

  it('addresses the same mount from a workspace, which the facet also serves', () => {
    expect(api.workspace('w1').metrics.url({ query: { dimension: 'model', period: 'week' } })).toBe(
      '/api/workspaces/w1/plugins/log/metrics?dimension=model&period=week',
    );
  });

  it('stays root-relative, which is the only form the sealed relay forwards', () => {
    for (const url of [scoped.metrics.url({ query: { dimension: 'model', period: 'week' } }), scoped.issues.url()]) {
      expect(url.startsWith('/api/')).toBe(true);
      expect(url.startsWith('//')).toBe(false);
    }
  });
});
