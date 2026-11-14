import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState, Prec } from '@codemirror/state';
import { drawSelection, EditorView, keymap, placeholder } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { Catalog } from './datasets';
import { sqlCompletions } from './sqlcomplete';
import { sqlSyntax } from './sqlsyntax';

const MONO = 'ui-monospace, Consolas, "Courier New", monospace';
const EDGE = '#6b7f9e';

const theme = EditorView.theme(
  {
    '&': { color: 'var(--gk-text)', backgroundColor: 'rgba(255,255,255,0.06)', border: `1px solid ${EDGE}`, borderRadius: '6px', fontSize: '12px', maxWidth: '100%' },
    '&.cm-focused': { outline: '2px solid var(--gk-accent)', outlineOffset: '1px' },
    '.cm-scroller': { fontFamily: MONO, lineHeight: '1.45', overflow: 'auto', maxHeight: 'min(45vh, 360px)' },
    '.cm-content': { minHeight: '8.5em', caretColor: 'var(--gk-text)', padding: '4px 0' },
    '.cm-line': { padding: '0 8px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--gk-text)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { background: 'rgba(255,138,61,0.38)' },
    '.cm-placeholder': { color: '#8b9ab0' },
    '&.cm-focused .cm-matchingBracket': { background: 'rgba(255,255,255,0.22)', outline: '1px solid #c8d3e3' },
    '&.cm-focused .cm-nonmatchingBracket': { background: 'rgba(255,90,90,0.35)' },
    '.cm-tooltip': { background: '#141e30', color: 'var(--gk-text)', border: `1px solid ${EDGE}`, borderRadius: '6px', boxShadow: '0 4px 14px rgba(0,0,0,0.55)' },
    '.cm-tooltip.cm-tooltip-autocomplete': { fontFamily: MONO, fontSize: '12px' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: MONO, maxWidth: 'min(460px, 88vw)', maxHeight: '15em' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px', color: 'var(--gk-text)', borderLeft: '3px solid transparent' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: '#5a3414', color: '#ffffff', borderLeftColor: 'var(--gk-accent)' },
    '.cm-completionDetail': { color: '#9aa7ba', fontStyle: 'normal', marginLeft: '0.8em' },
    '.cm-tooltip-autocomplete li[aria-selected] .cm-completionDetail': { color: '#e8d6c4' },
    '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700', color: '#ffb26e' },
    '.cm-tooltip-autocomplete li[aria-selected] .cm-completionMatchedText': { color: '#ffd9b3' },
    '.cm-completionInfo': { fontFamily: 'var(--gk-font)', fontSize: '12px', color: 'var(--gk-text)', padding: '4px 8px', maxWidth: 'min(320px, 80vw)', whiteSpace: 'normal' },
    '.cm-completionIcon': { color: '#9aa7ba' },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: '#ff9d5c', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: '#8fd694' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#7cc0ff' },
  { tag: [t.lineComment, t.blockComment], color: '#8b9ab0', fontStyle: 'italic' },
  { tag: [t.standard(t.name), t.standard(t.variableName), t.typeName, t.function(t.variableName)], color: '#d7a8ff' },
  { tag: [t.operator, t.punctuation, t.paren, t.bracket], color: '#c8d3e3' },
  { tag: t.special(t.name), color: '#ffd479' },
]);

export interface CmEditor {
  get(): string;
  set(text: string): void;
  /** Replace the selection (or insert at the cursor). */
  insert(text: string): void;
  focus(): void;
  measure(): void;
}

/**
 * The CodeMirror 6 SQL editor: highlighting and suggestions. Kept in a module of its own so that the page loads it
 * on demand (the first time SQL mode is opened).
 */
export function createCmEditor(o: { parent: HTMLElement; catalog: Catalog; doc: string; label: string; describedBy: string; placeholder: string; onRun: () => void }): CmEditor {
  const view: EditorView = new EditorView({
    parent: o.parent,
    state: EditorState.create({
      doc: o.doc,
      extensions: [
        // Ctrl/Cmd+Enter runs, ahead of the completion keys (plain Enter accepts a suggestion when the list is open).
        Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => (o.onRun(), true) }])),
        // Tab accepts the highlighted suggestion; with no list open it is not captured, so keyboard users can tab out.
        keymap.of([{ key: 'Tab', run: acceptCompletion }, ...completionKeymap, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
        history(),
        drawSelection(),
        bracketMatching(),
        closeBrackets(),
        EditorView.lineWrapping,
        placeholder(o.placeholder),
        sqlSyntax,
        syntaxHighlighting(highlight),
        autocompletion({ override: [sqlCompletions(o.catalog)], maxRenderedOptions: 60 }),
        EditorView.contentAttributes.of({ 'aria-label': o.label, 'aria-describedby': o.describedBy, spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
        theme,
      ],
    }),
  });
  return {
    get: () => view.state.doc.toString(),
    set: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } }),
    insert: (text) => view.dispatch(view.state.replaceSelection(text)),
    focus: () => view.focus(),
    measure: () => view.requestMeasure(),
  };
}
