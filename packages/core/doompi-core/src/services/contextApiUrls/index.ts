import { API_BASE_PATH, ITEM_ROUTE, NAME_QUERY_PARAM, KIND_QUERY_PARAM } from '../../constants/contextApi';
import type { ContextItemKind, ContextToolWarning } from '../../types/contextApi';

/** The absolute URL a page reads one row's detail through. */
export function itemDetailUrl(sessionPath: string, itemKind: ContextItemKind, name: string): string {
  const search = new URLSearchParams({
    [KIND_QUERY_PARAM]: itemKind,
    [NAME_QUERY_PARAM]: name,
  });
  return `${sessionPath}/plugins/${API_BASE_PATH}${ITEM_ROUTE}?${search.toString()}`;
}

const MAX_WARNING_PAYLOAD = 1024 * 1024;
const MAX_WARNING_TOOLS = 128;
const MAX_WARNINGS_PER_TOOL = 64;
const MAX_TOOL_NAME = 512;
const MAX_WARNING_SOURCE = 600;
const MAX_WARNING_PATH = 512;
const MAX_WARNING_MESSAGE = 512;
// Control characters are precisely the untrusted wire text this parser rejects.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

function warningText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !CONTROL_CHARACTERS.test(value);
}

/** Invalid or oversized status data is ignored as a whole, never partially trusted. */
export function parseContextToolWarnings(
  raw: string | undefined,
): Readonly<Record<string, readonly ContextToolWarning[]>> {
  if (raw === undefined || raw.length > MAX_WARNING_PAYLOAD) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed);
    if (entries.length > MAX_WARNING_TOOLS) return {};
    const result: [string, ContextToolWarning[]][] = [];
    for (const [name, warnings] of entries) {
      if (!warningText(name, MAX_TOOL_NAME) || !Array.isArray(warnings) || warnings.length > MAX_WARNINGS_PER_TOOL)
        return {};
      const clean: ContextToolWarning[] = [];
      for (const warning of warnings) {
        if (
          warning === null ||
          typeof warning !== 'object' ||
          Array.isArray(warning) ||
          !warningText(warning.source, MAX_WARNING_SOURCE) ||
          !warningText(warning.path, MAX_WARNING_PATH) ||
          !warningText(warning.message, MAX_WARNING_MESSAGE)
        )
          return {};
        clean.push({ source: warning.source, path: warning.path, message: warning.message });
      }
      result.push([name, clean]);
    }
    return Object.fromEntries(result);
  } catch {
    return {};
  }
}
