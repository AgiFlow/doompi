import { describe, expect, it } from 'vitest';
import {
  buildPromptDocument,
  describePrompt,
  hasArgumentTokens,
  isValidPromptName,
  parsePromptDocument,
} from '../../../src/services/savedPromptDocument.ts';

describe('saved prompt names', () => {
  it('accepts a lowercase slug', () => {
    expect(isValidPromptName('ship-review')).toBe(true);
    expect(isValidPromptName('r2')).toBe(true);
  });

  it('rejects names that would not survive as a file or a slash command', () => {
    for (const name of ['Ship', 'ship review', '-ship', 'ship/review', '../escape', '']) {
      expect(isValidPromptName(name), name).toBe(false);
    }
  });

  it('rejects a name longer than the limit', () => {
    expect(isValidPromptName('a'.repeat(65))).toBe(false);
  });
});

describe('prompt descriptions', () => {
  it('uses the first non-empty line', () => {
    expect(describePrompt('\n\n  Review the diff  \nand report\n')).toBe('Review the diff');
  });

  it('shortens a long first line', () => {
    const description = describePrompt('x'.repeat(200));

    expect(description).toHaveLength(80);
    expect(description.endsWith('…')).toBe(true);
  });

  it('returns nothing for empty text', () => {
    expect(describePrompt('   \n  ')).toBe('');
  });
});

describe('the prompt document format', () => {
  it('round-trips text and description through frontmatter', () => {
    const document = buildPromptDocument({ description: 'Review: the diff', text: 'Review the diff\nline two' });

    expect(document).toContain('description: "Review: the diff"');
    expect(parsePromptDocument('review', document)).toEqual({
      name: 'review',
      description: 'Review: the diff',
      text: 'Review the diff\nline two',
    });
  });

  it('escapes quotes so the frontmatter stays parseable', () => {
    const document = buildPromptDocument({ description: 'say "hi" \\ now', text: 'body' });

    expect(parsePromptDocument('quoted', document).description).toBe('say "hi" \\ now');
  });

  it('writes no frontmatter when there is no description', () => {
    expect(buildPromptDocument({ description: '', text: 'plain body' })).toBe('plain body\n');
  });

  it('reads a template written by hand, without frontmatter', () => {
    expect(parsePromptDocument('manual', 'Do the thing\nthen stop')).toEqual({
      name: 'manual',
      description: 'Do the thing',
      text: 'Do the thing\nthen stop',
    });
  });

  it('falls back to the body when frontmatter declares no description', () => {
    expect(parsePromptDocument('hinted', '---\nargument-hint: "<pr>"\n---\nReview $1').description).toBe('Review $1');
  });

  it('treats an unterminated fence as body text', () => {
    expect(parsePromptDocument('broken', '---\ndescription: "x"\nstill open').text).toBe(
      '---\ndescription: "x"\nstill open',
    );
  });

  it('normalises carriage returns', () => {
    expect(parsePromptDocument('crlf', '---\r\ndescription: "d"\r\n---\r\nbody\r\n').text).toBe('body');
  });
});

describe('argument token detection', () => {
  it('flags the tokens Pi substitutes on invocation', () => {
    for (const text of ['use $1', 'all $@', '${1:-x}', 'see $ARGUMENTS']) {
      expect(hasArgumentTokens(text), text).toBe(true);
    }
  });

  it('leaves ordinary prose alone', () => {
    expect(hasArgumentTokens('costs 5 dollars, not $ five')).toBe(false);
  });
});
