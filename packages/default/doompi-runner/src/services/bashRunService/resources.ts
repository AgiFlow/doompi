/** Classify known expensive commands without rewriting the user's shell command. */
export function isHeavyCommand(command: string): boolean {
  // ponytail: common build/test entry points only. Add explicit resource labels before scheduling opaque shell scripts.
  return command.split(/\s*(?:&&|\|\||[;|\n])\s*/).some((segment) => {
    let invocation = segment.trim().replace(/^(?:[A-Za-z_][A-Za-z_0-9]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, '');
    invocation = invocation.replace(/^(?:env|command|exec|time)\s+/, '');
    const packageManager =
      /^(?:pnpm|npm|npx|yarn|bun)\s+(?:(?:--filter|--dir|-C)\s+\S+\s+|(?:-w|--workspace-root)\s+)*(?:(?:exec|run)\s+)?/.exec(
        invocation,
      );
    if (packageManager) invocation = invocation.slice(packageManager[0].length);
    if (/(?:^|\s)--(?:help|version)(?:\s|$)/.test(invocation)) return false;
    if (packageManager && /^(?:build|test|lint|typecheck|check)(?::[\w-]+)?(?:\s|$)/.test(invocation)) return true;
    if (/^(?:\S*\/)?(?:vitest|jest|tsc|tsdown|webpack|rollup|esbuild)(?:\s|$)/.test(invocation)) return true;
    return (
      /^nx\s+(?!(?:show|graph|daemon|reset)\b)/.test(invocation) &&
      /(?:^|[\s:,])(?:build|test(?:-[\w-]+)?|lint|typecheck)(?:[\s:,=]|$)/.test(invocation)
    );
  });
}
