/**
 * The editor's colours, as plain data.
 *
 * Every value is a CSS custom property rather than a resolved colour, which is
 * what lets a theme swap recolour a mounted editor by rewriting `:root`
 * instead of tearing the editor down and rebuilding it. It is also why this is
 * data and not a built CodeMirror extension: nothing here imports an editor,
 * so a caller pays for the styles only inside the chunk that draws them.
 */

/** The chrome: the surface, the gutter, the cursor, the selection, and the search panel. */
export const DOOM_EDITOR_STYLES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '&': {
    color: 'var(--doom-text)',
    backgroundColor: 'var(--doom-deep)',
    fontSize: '12px',
    height: '100%',
  },
  '.cm-scroller': {
    fontFamily: 'var(--doom-font-mono)',
    lineHeight: '1.5',
  },
  '.cm-content': {
    caretColor: 'var(--doom-blue)',
    padding: '8px 0',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--doom-blue)',
    borderLeftWidth: '2px',
  },
  // CodeMirror draws its own selection layer when the editor has focus and
  // leans on the native one when it does not, so both need saying or a
  // selection vanishes the moment a reader clicks the comment box.
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--doom-selected)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--doom-deep)',
    color: 'var(--doom-faint)',
    borderRight: '1px solid var(--doom-border-soft)',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--doom-panel)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--doom-panel)',
    color: 'var(--doom-dim)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--doom-panel)',
    border: '1px solid var(--doom-border)',
    color: 'var(--doom-dim)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--doom-tint-yellow)',
    outline: '1px solid var(--doom-edge-yellow)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--doom-tint-orange)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'var(--doom-tint-blue)',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--doom-tint-green)',
    outline: '1px solid var(--doom-edge-green)',
  },
  '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'var(--doom-tint-red)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--doom-panel)',
    color: 'var(--doom-text)',
    fontSize: '11px',
  },
  '.cm-panels.cm-panels-bottom': {
    borderTop: '1px solid var(--doom-border)',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid var(--doom-border)',
  },
  '.cm-panel input, .cm-panel button, .cm-panel select': {
    backgroundColor: 'var(--doom-deep)',
    color: 'var(--doom-text)',
    border: '1px solid var(--doom-border)',
    borderRadius: '2px',
    fontFamily: 'var(--doom-font-mono)',
    fontSize: '11px',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--doom-panel)',
    border: '1px solid var(--doom-border)',
    color: 'var(--doom-text)',
  },
};

/**
 * The syntax colours, named by what they mark rather than by tag, so the
 * pairing with Lezer's tags stays next to the editor that imports them and
 * this table can be read as a palette.
 */
export const DOOM_SYNTAX_STYLES = {
  comment: { color: 'var(--doom-faint)', fontStyle: 'italic' },
  keyword: { color: 'var(--doom-magenta)' },
  constant: { color: 'var(--doom-violet)' },
  literal: { color: 'var(--doom-orange)' },
  string: { color: 'var(--doom-green)' },
  regexp: { color: 'var(--doom-teal)' },
  operator: { color: 'var(--doom-blue)' },
  punctuation: { color: 'var(--doom-dim)' },
  variable: { color: 'var(--doom-text)' },
  property: { color: 'var(--doom-cyan)' },
  callable: { color: 'var(--doom-blue)' },
  type: { color: 'var(--doom-yellow)' },
  tag: { color: 'var(--doom-red)' },
  attribute: { color: 'var(--doom-yellow)' },
  meta: { color: 'var(--doom-faint)' },
  heading: { color: 'var(--doom-hi)', fontWeight: 'bold' },
  link: { color: 'var(--doom-cyan)', textDecoration: 'underline' },
  emphasis: { fontStyle: 'italic' },
  strong: { fontWeight: 'bold' },
  strikethrough: { textDecoration: 'line-through' },
  invalid: { color: 'var(--doom-red)' },
} as const;
