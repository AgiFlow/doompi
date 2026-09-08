#!/usr/bin/env node
/**
 * One-shot codemod replacing ad-hoc Tailwind values with the design tokens
 * declared in `packages/core/doompi-web-components/styles/tokens.css`.
 *
 * Every replacement happens in a SINGLE pass over each file. That is the whole
 * point of the alternation below: `text-xs` maps to `text-sm` while `text-sm`
 * itself maps to `text-base`, so running the rules one after another would
 * apply a rule to output an earlier rule had just produced.
 *
 * Components whose `cva` size ladder needs a rung-by-rung decision are excluded
 * and were converted by hand; a nearest-value mapping collapses two of their
 * rungs onto the same token.
 *
 * Usage: node scripts/style-system-token-codemod.mjs [--dry]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

/** Size ladders converted by hand, where nearest-value mapping collapses rungs. */
const LADDER_FILES = new Set([
  'packages/core/doompi-web-components/src/components/Badge.tsx',
  'packages/core/doompi-web-components/src/components/Button.tsx',
  'packages/core/doompi-web-components/src/components/Input.tsx',
  'packages/core/doompi-web-components/src/components/StatusBadge.tsx',
]);

/**
 * Ordered so the regex alternation prefers the longest source first; `text-[8px]`
 * must win over any shorter prefix that could also match at the same position.
 */
const MAPPING = new Map([
  // Font size: nine ad-hoc sizes collapse onto the five-step scale.
  ['text-[8px]', 'text-2xs'],
  ['text-[9px]', 'text-2xs'],
  ['text-[10px]', 'text-xs'],
  ['text-[11px]', 'text-sm'],
  ['text-[12px]', 'text-sm'],
  ['text-[13px]', 'text-base'],
  ['text-[14px]', 'text-base'],
  ['text-[15px]', 'text-lg'],
  ['text-[16px]', 'text-lg'],
  // Named steps keep their RENDERED size rather than their name: the scale
  // redefines every step downward, so `text-xs` (was 12px) becomes `text-sm`.
  ['text-xs', 'text-sm'],
  ['text-sm', 'text-base'],
  ['text-base', 'text-lg'],
  // Radius.
  ['rounded-[1px]', 'rounded-xs'],
  ['rounded-[2px]', 'rounded-xs'],
  ['rounded-[3px]', 'rounded-sm'],
  ['rounded-[5px]', 'rounded-md'],
  ['rounded-[10px]', 'rounded-lg'],
  // Letter spacing.
  ['tracking-[0.08em]', 'tracking-wide'],
  ['tracking-[0.14em]', 'tracking-wider'],
  ['tracking-[0.16em]', 'tracking-wider'],
  ['tracking-[0.18em]', 'tracking-widest'],
  ['tracking-[0.25em]', 'tracking-widest'],
  // Line height maps onto Tailwind's stock steps, so no token is redefined.
  ['leading-[1.5]', 'leading-normal'],
  ['leading-[1.6]', 'leading-relaxed'],
  ['leading-[15px]', 'leading-tight'],
  ['leading-[17px]', 'leading-snug'],
]);

const escape = (value) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * A utility is a whole class token: it may follow a variant colon or a quote but
 * never another word character or hyphen, which is what keeps `text-2xs` from
 * matching the `text-xs` rule.
 */
const PATTERN = new RegExp(String.raw`(?<![\w-])(${[...MAPPING.keys()].map(escape).join('|')})(?![\w-])`, 'g');

const dryRun = process.argv.includes('--dry');
const files = execFileSync('git', ['ls-files', '*.tsx', '*.ts'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file.length > 0 && !LADDER_FILES.has(file));

const totals = new Map();
let changedFiles = 0;

for (const file of files) {
  const before = readFileSync(file, 'utf8');
  const after = before.replaceAll(PATTERN, (_match, token) => {
    totals.set(token, (totals.get(token) ?? 0) + 1);
    return MAPPING.get(token);
  });
  if (after === before) continue;
  changedFiles += 1;
  if (!dryRun) writeFileSync(file, after);
}

for (const [token, count] of [...totals.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(count).padStart(4)}  ${token}  ->  ${MAPPING.get(token)}`);
}
const replaced = [...totals.values()].reduce((sum, count) => sum + count, 0);
console.log(`\n${replaced} replacements across ${changedFiles} files${dryRun ? ' (dry run)' : ''}`);
