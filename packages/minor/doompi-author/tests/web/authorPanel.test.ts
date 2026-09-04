import { describe, expect, it } from 'vitest';
import { authorFileTab } from '../../src/web/AuthorDocumentPanel.tsx';
import { webPlugin } from '../../src/web/index.ts';

describe('the Author web plugin', () => {
  it('does not register a permanent workspace tab', () => {
    expect(webPlugin.tabs ?? []).toEqual([]);
  });

  it('opens documents as closeable retained-Composer tabs', () => {
    expect(authorFileTab('docs/report.md')).toMatchObject({
      label: 'report.md',
      retainComposer: true,
    });
  });
});
