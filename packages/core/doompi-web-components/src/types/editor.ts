/**
 * The vocabulary a file surface shares: how a file is shown, and what an
 * editor hands back when a reader selects part of one.
 *
 * It lives here rather than beside the components so a caller can classify a
 * path, or hold a selection in its own state, without pulling the editor
 * chunk in behind it.
 */

/** How a file is shown when its bytes are not text: inline by kind, or offered as a download. */
export const MEDIA_KINDS = ['image', 'video', 'pdf', 'download'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * What a reader picked out, in the terms a review comment needs: the text
 * itself, and where it sits. Lines are one-based, matching what an editor
 * gutter shows, and a caret with nothing selected reports the same line twice
 * with empty text.
 */
export interface EditorSelectionRange {
  text: string;
  startLine: number;
  endLine: number;
}

/** A zero-based half-open range in the mounted editor document. */
export interface EditorTextRange {
  from: number;
  to: number;
}

/** One replacement applied with the other edits in a single editor transaction. */
export interface EditorEdit extends EditorTextRange {
  insert: string;
}

/** The deliberately small imperative surface exposed by a mounted editor. */
export interface CodeEditorController {
  focus: () => void;
  revealAndSelect: (range: EditorTextRange) => void;
  applyEdits: (edits: readonly EditorEdit[]) => void;
  setClosedRanges: (ranges: readonly EditorTextRange[]) => void;
}

export interface CodeEditorProps {
  value: string;
  /**
   * The file this content came from. It picks the syntax grammar and nothing
   * else; leave it off and the editor stays plain text.
   */
  path?: string;
  readOnly?: boolean;
  /**
   * Wraps long lines rather than scrolling sideways. On by default, because
   * the cockpit is read on phones and unwrapped code there is unreadable.
   */
  lineWrapping?: boolean;
  className?: string;
  'data-testid'?: string;
  onChange?: (value: string) => void;
  onSelect?: (range: EditorSelectionRange) => void;
  /** Receives the controller while the CodeMirror view is mounted, and `null` after it is destroyed. */
  controllerRef?: import('react').Ref<CodeEditorController>;
}
