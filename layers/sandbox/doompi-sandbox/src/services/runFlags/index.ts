/**
 * Splits configured engine options into argv entries.
 *
 * Whitespace separated rather than shell parsed: the engine is spawned without
 * a shell, so quoting rules would only invent a syntax the caller does not
 * actually get.
 */
export function parseRunFlags(configured: string | undefined): string[] {
  return (configured ?? '').split(/\s+/).filter((flag) => flag.length > 0);
}

const OPTION_FORM = /^--?[^\s=]+(=.*)?$/s;

/**
 * Requires every configured entry to be a self-contained option.
 *
 * Separated values cannot be told from positional arguments without knowing
 * each option's arity, and a stray positional would silently replace the image
 * or its command. Demanding `--flag=value` removes the ambiguity instead of
 * guessing at it.
 */
export function assertRunFlags(flags: readonly string[], optionName: string): void {
  const invalid = flags.find((flag) => !OPTION_FORM.test(flag));
  if (invalid !== undefined) {
    throw new Error(
      `${optionName} accepts engine options in --flag or --flag=value form; "${invalid}" is neither. ` +
        'Write a value as part of its option, for example --runtime=runsc.',
    );
  }
}
