/**
 * What one entry in the composition actually is, for a reader who clicked it.
 *
 * The projection prices the composition and stops there: names, owners, and
 * integer counts, small enough to republish whenever the composition changes.
 * The prose and the schema behind a figure are an order of magnitude larger and
 * are wanted one row at a time, so they travel on request instead. This module
 * is the contract both ends of that request share, and it is deliberately free
 * of Node imports so a browser can hold it too.
 */

/** Where a host mounts this package's API; the segment after /api/plugin/. */
export const API_BASE_PATH = 'context';

/** The session a proxied request belongs to; the hub strips it before forwarding. */
export const SESSION_QUERY_PARAM = 'session';

export const ITEM_ROUTE = '/item';

export const NAME_QUERY_PARAM = 'name';

export const KIND_QUERY_PARAM = 'kind';

export const CONTEXT_DETAIL_VERSION = 1;
