import type { WebTemplateContribution } from '../types/template';

/** Check separately from loading the package so one unsupported layout does not break the catalog. */
export function parseWebTemplate(value: unknown): WebTemplateContribution | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' ||
    candidate.id.length > 160 ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(candidate.id) ||
    typeof candidate.label !== 'string' ||
    candidate.label.trim() === '' ||
    typeof candidate.description !== 'string' ||
    candidate.contractVersion !== 1
  )
    return undefined;
  const layout = candidate.layout;
  const wrapped =
    typeof layout === 'object' &&
    layout !== null &&
    '$$typeof' in layout &&
    (layout.$$typeof === Symbol.for('react.memo') || layout.$$typeof === Symbol.for('react.forward_ref'));
  if (typeof layout !== 'function' && !wrapped) return undefined;
  return candidate as unknown as WebTemplateContribution;
}
