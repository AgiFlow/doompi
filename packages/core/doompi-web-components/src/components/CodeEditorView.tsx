import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
  WidgetType,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { cn } from '../lib/cn.ts';
import { boundedEditorEdits, boundedEditorRanges } from '../lib/editorController.ts';
import { grammarKeyOf, loadGrammar } from '../lib/editorLanguage.ts';
import { DOOM_EDITOR_STYLES, DOOM_SYNTAX_STYLES } from '../lib/editorTheme.ts';
import type { CodeEditorProps, EditorSelectionRange, EditorViewportRectangle } from '../types/editor.ts';

function selectionRange(editor: { readonly state: EditorState }, from: number, to: number): EditorSelectionRange {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  return {
    text: editor.state.sliceDoc(start, end),
    from: start,
    to: end,
    startLine: editor.state.doc.lineAt(start).number,
    endLine: editor.state.doc.lineAt(end).number,
  };
}

export function resolveEditorViewportRegion(
  editor: {
    readonly state: EditorState;
    posAtCoords(coords: { x: number; y: number }): number | null;
  },
  rectangle: EditorViewportRectangle,
): EditorSelectionRange | null {
  const start = editor.posAtCoords({ x: rectangle.left, y: rectangle.top });
  const end = editor.posAtCoords({ x: rectangle.right, y: rectangle.bottom });
  if (start === null || end === null) return null;
  return selectionRange(editor, start, end);
}
/**
 * The editor itself, mounted on a real CodeMirror view.
 *
 * Nothing imports this module directly: `CodeEditor` reaches it through a lazy
 * import so the whole editor, and every grammar under it, stays out of the
 * cockpit's first load. Behaviour lives here rather than in that wrapper so
 * the split costs one file and no indirection.
 *
 * The three things a caller can change after mount each sit in their own
 * compartment. Reconfiguring one is a transaction; rebuilding the editor would
 * throw away the undo history, the scroll position and the cursor, which is
 * what a reader loses if a parent re-render is allowed to remount this.
 */

/** Not a colour or a layout choice: how CodeMirror is told to draw the doom palette. */
const DOOM_THEME = EditorView.theme(DOOM_EDITOR_STYLES);

const DOOM_HIGHLIGHT = HighlightStyle.define([
  { tag: tags.comment, ...DOOM_SYNTAX_STYLES.comment },
  { tag: tags.keyword, ...DOOM_SYNTAX_STYLES.keyword },
  { tag: [tags.atom, tags.bool, tags.null, tags.self], ...DOOM_SYNTAX_STYLES.constant },
  { tag: tags.number, ...DOOM_SYNTAX_STYLES.literal },
  { tag: [tags.string, tags.special(tags.string), tags.character], ...DOOM_SYNTAX_STYLES.string },
  { tag: tags.regexp, ...DOOM_SYNTAX_STYLES.regexp },
  { tag: tags.operator, ...DOOM_SYNTAX_STYLES.operator },
  { tag: tags.punctuation, ...DOOM_SYNTAX_STYLES.punctuation },
  { tag: tags.variableName, ...DOOM_SYNTAX_STYLES.variable },
  { tag: tags.propertyName, ...DOOM_SYNTAX_STYLES.property },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], ...DOOM_SYNTAX_STYLES.callable },
  { tag: [tags.typeName, tags.className, tags.namespace], ...DOOM_SYNTAX_STYLES.type },
  { tag: tags.tagName, ...DOOM_SYNTAX_STYLES.tag },
  { tag: tags.attributeName, ...DOOM_SYNTAX_STYLES.attribute },
  { tag: [tags.meta, tags.processingInstruction], ...DOOM_SYNTAX_STYLES.meta },
  { tag: tags.heading, ...DOOM_SYNTAX_STYLES.heading },
  { tag: [tags.link, tags.url], ...DOOM_SYNTAX_STYLES.link },
  { tag: tags.emphasis, ...DOOM_SYNTAX_STYLES.emphasis },
  { tag: tags.strong, ...DOOM_SYNTAX_STYLES.strong },
  { tag: tags.strikethrough, ...DOOM_SYNTAX_STYLES.strikethrough },
  { tag: tags.invalid, ...DOOM_SYNTAX_STYLES.invalid },
]);

const setClosedDecorations = StateEffect.define<DecorationSet>();
const closedDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setClosedDecorations)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const setMarkedDecorations = StateEffect.define<DecorationSet>();
const markedDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setMarkedDecorations)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class MarkedRangeLabel extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }

  eq(other: MarkedRangeLabel): boolean {
    return other.label === this.label;
  }

  toDOM(): HTMLElement {
    const label = document.createElement('span');
    label.className = 'cm-marked-region-label';
    label.dataset.authorRegionLabel = this.label;
    label.textContent = this.label;
    return label;
  }
}

const MARKED_REGION_THEME = EditorView.baseTheme({
  '.cm-marked-region': {
    backgroundColor: 'var(--doom-tint-yellow)',
    borderBottom: '1px solid var(--doom-edge-yellow)',
  },
  '.cm-marked-region-label': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '16px',
    height: '16px',
    marginRight: '4px',
    borderRadius: '999px',
    backgroundColor: 'var(--doom-yellow)',
    color: 'var(--doom-deep)',
    fontSize: '9px',
    fontWeight: '700',
    lineHeight: '1',
    verticalAlign: 'text-bottom',
  },
});

/** Everything that never changes for the life of an editor. */
const FIXED_EXTENSIONS = [
  lineNumbers(),
  highlightActiveLineGutter(),
  foldGutter(),
  highlightActiveLine(),
  drawSelection(),
  rectangularSelection(),
  indentOnInput(),
  bracketMatching(),
  history(),
  search({ top: true }),
  highlightSelectionMatches(),
  // Tab indents rather than leaving the editor. That trades a keyboard user's
  // escape route for the behaviour every other editor has, so it is last in
  // the keymap and Escape then Tab still moves focus out.
  keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
  syntaxHighlighting(DOOM_HIGHLIGHT),
  closedDecorations,
  markedDecorations,
  MARKED_REGION_THEME,
  DOOM_THEME,
];

export function CodeEditorView({
  value,
  path,
  readOnly = false,
  lineWrapping = true,
  className,
  onChange,
  onSelect,
  controllerRef,
  'data-testid': testId,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The callbacks are new objects on every parent render. Reading them through
  // a ref is what lets the editor be built once and still call the current
  // pair, rather than being rebuilt whenever the parent re-renders.
  const handlers = useRef({ onChange, onSelect });
  // The document is seeded once from the value of the first render; the sync effect
  // below owns every later change.
  const initialValue = useRef(value);
  const compartments = useRef({
    language: new Compartment(),
    readOnly: new Compartment(),
    wrapping: new Compartment(),
  });

  useEffect(() => {
    handlers.current = { onChange, onSelect };
  });

  useLayoutEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    const { language, readOnly: readOnlyPart, wrapping } = compartments.current;
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        // The initial document only; every later change arrives as a
        // transaction from the effect below.
        doc: initialValue.current,
        extensions: [
          ...FIXED_EXTENSIONS,
          language.of([]),
          readOnlyPart.of([]),
          wrapping.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) handlers.current.onChange?.(update.state.doc.toString());
            if (!update.selectionSet && !update.docChanged) return;
            const report = handlers.current.onSelect;
            if (report === undefined) return;
            const range = update.state.selection.main;
            report(selectionRange(update.view, range.from, range.to));
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Built once.
  }, []);

  useImperativeHandle(
    controllerRef,
    () => ({
      focus: () => view.current?.focus(),
      revealAndSelect: (range) => {
        const editor = view.current;
        if (editor === null) return;
        const [bounded] = boundedEditorRanges(editor.state.doc.length, [range]);
        if (bounded === undefined) return;
        editor.dispatch({
          selection: { anchor: bounded.from, head: bounded.to },
          effects: EditorView.scrollIntoView(bounded.from, { y: 'center' }),
        });
      },
      applyEdits: (edits) => {
        const editor = view.current;
        if (editor === null || edits.length === 0) return;
        editor.dispatch({ changes: boundedEditorEdits(editor.state.doc.length, edits) });
      },
      setClosedRanges: (ranges) => {
        const editor = view.current;
        if (editor === null) return;
        const bounded = boundedEditorRanges(editor.state.doc.length, ranges);
        const decorations = bounded.map((range) =>
          range.from === range.to
            ? Decoration.line({ attributes: { class: 'cm-closed-tone', 'data-tone': 'closed' } }).range(
                editor.state.doc.lineAt(range.from).from,
              )
            : Decoration.mark({ class: 'cm-closed-tone', attributes: { 'data-tone': 'closed' } }).range(
                range.from,
                range.to,
              ),
        );
        editor.dispatch({ effects: setClosedDecorations.of(Decoration.set(decorations)) });
      },
      setMarkedRanges: (ranges) => {
        const editor = view.current;
        if (editor === null) return;
        const decorations = ranges.flatMap((range) => {
          const [bounded] = boundedEditorRanges(editor.state.doc.length, [range]);
          if (bounded === undefined || bounded.from === bounded.to) return [];
          return [
            Decoration.widget({ widget: new MarkedRangeLabel(range.label), side: -1 }).range(bounded.from),
            Decoration.mark({
              class: 'cm-marked-region',
              attributes: { 'data-author-region': range.label },
            }).range(bounded.from, bounded.to),
          ];
        });
        editor.dispatch({ effects: setMarkedDecorations.of(Decoration.set(decorations, true)) });
      },
      resolveViewportRegion: (rectangle) => {
        const editor = view.current;
        return editor === null ? null : resolveEditorViewportRegion(editor, rectangle);
      },
    }),
    [],
  );

  useEffect(() => {
    const editor = view.current;
    // A caller that echoes onChange back into `value` would otherwise replace
    // the document on every keystroke and drop the cursor to the end.
    if (editor === null || editor.state.doc.toString() === value) return;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.readOnly.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.wrapping.reconfigure(lineWrapping ? EditorView.lineWrapping : []),
    });
  }, [lineWrapping]);

  useEffect(() => {
    const key = path === undefined ? undefined : grammarKeyOf(path);
    const { language } = compartments.current;
    if (key === undefined) {
      view.current?.dispatch({ effects: language.reconfigure([]) });
      return;
    }
    let cancelled = false;
    void loadGrammar(key)
      .then((grammar) => {
        if (!cancelled) view.current?.dispatch({ effects: language.reconfigure(grammar) });
      })
      .catch(() => {
        // A grammar is a separate chunk over the network, and the cockpit is
        // often read through a tunnel. Losing it costs syntax colour, not the
        // file, so fall back to plain text rather than failing the pane.
        if (!cancelled) view.current?.dispatch({ effects: language.reconfigure([]) });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return <div ref={host} data-testid={testId} className={cn('min-h-0 overflow-hidden', className)} />;
}
