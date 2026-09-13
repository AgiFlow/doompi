export function splitCommandLine(template: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | undefined;
  let escaped = false;
  for (const character of template.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\' && quote !== 'single') {
      escaped = true;
    } else if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single';
    } else if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double';
    } else if (/\s/u.test(character) && quote === undefined) {
      if (current) result.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (escaped) current += '\\';
  if (quote !== undefined) throw new Error('Editor command has an unterminated quote');
  if (current) result.push(current);
  if (result.length === 0) throw new Error('Editor command must not be empty');
  return result;
}

export function validateEditorTemplate(template: string): void {
  for (const match of template.matchAll(/\{([^}]+)\}/gu)) {
    if (match[1] !== 'file' && match[1] !== 'line') {
      throw new Error(`Unsupported editor placeholder: {${match[1]}}`);
    }
  }
  splitCommandLine(template);
}

export function expandEditorTemplate(template: string, file: string, line: number): string[] {
  validateEditorTemplate(template);
  const hasFile = template.includes('{file}');
  const values = splitCommandLine(template).map((part) =>
    part.replaceAll('{file}', file).replaceAll('{line}', String(line)),
  );
  if (!hasFile) values.push(file);
  return values;
}
