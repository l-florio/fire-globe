import { StreamLanguage } from '@codemirror/language';
import { FUNCTION_NAMES, KEYWORD_WORDS } from './sqlcomplete';

interface State {
  /** Inside a block comment that started on an earlier line. */
  block: boolean;
}

/**
 * A small SQL tokenizer for highlighting (keywords, functions, strings, numbers, comments, operators).
 * Used instead of @codemirror/lang-sql, whose per-dialect keyword tables add about 100 KB.
 */
export const sqlSyntax = StreamLanguage.define<State>({
  name: 'sql',
  startState: () => ({ block: false }),
  token(stream, state) {
    if (state.block) {
      if (stream.skipTo('*/')) {
        stream.match('*/');
        state.block = false;
      } else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('--')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      if (stream.skipTo('*/')) stream.match('*/');
      else {
        stream.skipToEnd();
        state.block = true;
      }
      return 'comment';
    }
    const q = stream.peek();
    if (q === "'" || q === '"') {
      stream.next();
      for (let c = stream.next(); c != null; c = stream.next()) {
        if (c === q) {
          if (stream.peek() === q) stream.next();
          else break;
        }
      }
      return q === "'" ? 'string' : 'variableName';
    }
    if (stream.match(/^\d+(?:\.\d*)?(?:[eE][+-]?\d+)?/) || stream.match(/^\.\d+/)) return 'number';
    if (stream.match(/^[A-Za-z_][\w$]*/)) {
      const w = stream.current().toLowerCase();
      if (w === 'true' || w === 'false' || w === 'null') return 'atom';
      if (KEYWORD_WORDS.has(w)) return 'keyword';
      if (FUNCTION_NAMES.has(w) && stream.match(/^\s*\(/, false)) return 'builtin';
      return null;
    }
    if (stream.match(/^[-+*/%=<>!|&:^~]+/)) return 'operator';
    stream.next();
    return null;
  },
});
