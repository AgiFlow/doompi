/**
 * What a path knows about a contribution's identity.
 *
 * The generator supplies these and the authored file is spread over the top,
 * so a file that states its own name or id always wins. That is what lets the
 * filename be the identity without taking the choice away.
 */

/** `write-plan` and `writePlan` both become `write_plan`. */
export function toSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .toLowerCase()
    .replaceAll('-', '_');
}

/** `PlanPanel` becomes `plan-panel`; an already-kebab name is unchanged. */
export function toKebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase();
}

/** One derived field and the literal it holds. */
export type Identity = Readonly<Record<string, string | readonly string[]>>;

/** Renders an identity as object-literal members, ready to precede a spread. */
export function renderIdentity(identity: Identity): string {
  return Object.entries(identity)
    .map(([key, value]) =>
      Array.isArray(value)
        ? `${key}: [${value.map((item) => `'${item}'`).join(', ')}]`
        : `${key}: '${value as string}'`,
    )
    .join(', ');
}
