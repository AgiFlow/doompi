const quoteFile = (file) => JSON.stringify(file);

module.exports = {
  '**/*.{js,mjs,cjs,ts,tsx,jsx,json,jsonc,yaml,yml,md}': [
    (files) => `pnpm exec oxfmt ${files.map(quoteFile).join(' ')}`,
  ],
  '**/*.{ts,tsx}': [() => 'pnpm exec nx affected --target=typecheck --parallel=1'],
};
