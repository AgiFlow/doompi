import {
  API_BASE_PATH,
  SESSION_QUERY_PARAM,
  ITEM_ROUTE,
  NAME_QUERY_PARAM,
  KIND_QUERY_PARAM,
} from '../../constants/contextApi';
import type { ContextItemKind } from '../../types/contextApi';

/** The absolute URL a page reads one row's detail through. */
export function itemDetailUrl(sessionId: string, itemKind: ContextItemKind, name: string): string {
  const search = new URLSearchParams({
    [SESSION_QUERY_PARAM]: sessionId,
    [KIND_QUERY_PARAM]: itemKind,
    [NAME_QUERY_PARAM]: name,
  });
  return `/api/sessions/${encodeURIComponent(sessionId)}/plugin/${API_BASE_PATH}${ITEM_ROUTE}?${search.toString()}`;
}
