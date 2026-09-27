export function harnessErrorMessage(error: unknown, seen = new Set<object>()): string {
  if (typeof error === 'string') return error;
  if (!(error instanceof Error)) return 'Direct harness operation failed';
  if (seen.has(error)) return '[repeated error]';
  seen.add(error);
  const details = [
    ...(error.cause === undefined ? [] : [harnessErrorMessage(error.cause, seen)]),
    ...(error instanceof AggregateError
      ? error.errors.map((failure: unknown) => harnessErrorMessage(failure, seen))
      : []),
  ];
  return [error.message, ...details].filter(Boolean).join(': ');
}
