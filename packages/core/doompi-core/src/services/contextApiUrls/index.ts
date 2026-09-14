import { API_BASE_PATH, ITEM_ROUTE, NAME_QUERY_PARAM, KIND_QUERY_PARAM } from '../../constants/contextApi';
import type { ContextItemKind } from '../../types/contextApi';

/** The absolute URL a page reads one row's detail through. */
export function itemDetailUrl(sessionPath: string, itemKind: ContextItemKind, name: string): string {
  const search = new URLSearchParams({
    [KIND_QUERY_PARAM]: itemKind,
    [NAME_QUERY_PARAM]: name,
  });
  return `${sessionPath}/plugins/${API_BASE_PATH}${ITEM_ROUTE}?${search.toString()}`;
}
