/** Split shell words without mistaking quoted examples for executed commands. */
function commandInvocations(command: string): string[][] {
  const invocations: string[][] = [];
  let words: string[] = [];
  let word = '';
  let quote = '';
  let escaped = false;
  const flushWord = (): void => {
    if (word) words.push(word);
    word = '';
  };
  for (const character of command) {
    if (escaped) {
      word += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = '';
      else word += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (';&|\n'.includes(character)) {
      flushWord();
      if (words.length) invocations.push(words);
      words = [];
    } else if (/\s/.test(character)) {
      flushWord();
    } else {
      word += character;
    }
  }
  flushWord();
  if (words.length) invocations.push(words);
  return invocations;
}

function executableName(word: string): string {
  return word.replace(/\\/g, '/').split('/').pop() ?? word;
}

/** Admission policy, not a shell security boundary. Opaque scripts still need explicit ownership. */
export function isHeavyCommand(command: string): boolean {
  const heavyTarget =
    /(?:^|[\s:,=])(?:build(?:-[\w-]+)?|test(?:-[\w-]+)?|lint|fixcode|typecheck|check|bundle)(?:[\s:,=]|$)/;
  const expensiveBinary =
    /^(?:vitest|jest|tsc|tsgo|tsdown|webpack|rollup|esbuild|oxlint|oxfmt|pytest|maestro|xcodebuild|gradle|gradlew)$/;
  return commandInvocations(command).some((words) => {
    while (words.length) {
      const first = words[0]!;
      if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(first) || /^(?:env|command|exec|time)$/.test(executableName(first))) {
        words.shift();
      } else break;
    }
    let executable = executableName(words.shift() ?? '');
    if (words.includes('--help') || words.includes('--version')) return false;
    if (/^(?:pnpm|npm|npx|yarn|bun)$/.test(executable)) {
      while (words[0]?.startsWith('-')) {
        const option = words.shift()!;
        if (/^(?:--filter|--dir|-C|--cwd|--prefix)$/.test(option)) words.shift();
      }
      if (words[0] === 'exec' || words[0] === 'run') words.shift();
      const invocation = words.shift() ?? '';
      if (/^(?:build|test|lint|fixcode|typecheck|check)(?::[\w-]+)?$/.test(invocation)) return true;
      executable = executableName(invocation);
    }
    if (expensiveBinary.test(executable)) return true;
    if (executable === 'nx') {
      if (/^(?:show|graph|daemon|reset|report|list)$/.test(words[0] ?? '')) return false;
      return heavyTarget.test(words.join(' '));
    }
    if (/^(?:playwright|vite|cargo|go)$/.test(executable)) return heavyTarget.test(words.join(' '));
    if (/^(?:python|python3)$/.test(executable)) return words[0] === '-m' && words[1] === 'pytest';
    if (/^(?:node|bun|tsx)$/.test(executable)) {
      executable = executableName(words.find((word) => !word.startsWith('-')) ?? '');
    }
    const script = executable.replace(/\.(?:[cm]?[jt]s)$/, '');
    return (
      script !== executable &&
      (expensiveBinary.test(script) || /^(?:build|test|lint|fixcode|typecheck|dev)(?:[-:]|$)/.test(script))
    );
  });
}
