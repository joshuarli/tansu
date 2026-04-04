/// Minimal syntax highlighter for code blocks.
/// Ported from ~/d/nerv/src/tui/highlight.rs — byte-by-byte highlighter.

const enum Hl {
  Normal,
  Keyword,
  Type,
  String,
  Comment,
  Number,
  Bracket,
  Operator,
  Function,
  Constant,
  Macro,
}

const hlClass: (string | null)[] = [
  null,        // Normal
  'hl-kw',     // Keyword
  'hl-type',   // Type
  'hl-str',    // String
  'hl-cmt',    // Comment
  'hl-num',    // Number
  'hl-brk',    // Bracket
  'hl-op',     // Operator
  'hl-fn',     // Function
  'hl-const',  // Constant
  'hl-macro',  // Macro
];

const enum State {
  Normal,
  BlockComment,
  MultiLineString, // index stored separately
}

interface HlState {
  state: State;
  stringIdx: number;
}

interface Rules {
  lineComment: string;
  blockComment: [string, string];
  strings: [string, string, boolean][]; // [open, close, multiline]
  keywords: string[];
  types: string[];
  operators: string[];
  highlightNumbers: boolean;
  highlightFnCalls: boolean;
  highlightBangMacros: boolean;
}

function isSep(c: number): boolean {
  return (c <= 0x20) || // whitespace/control
    c === 0x2C || c === 0x2E || // , .
    c === 0x28 || c === 0x29 || // ( )
    c === 0x2B || c === 0x2D || // + -
    c === 0x2F || c === 0x2A || // / *
    c === 0x3D || c === 0x7E || // = ~
    c === 0x25 || c === 0x3C || // % <
    c === 0x3E || c === 0x5B || // > [
    c === 0x5D || c === 0x7B || // ] {
    c === 0x7D || c === 0x3B || // } ;
    c === 0x3A || c === 0x26 || // : &
    c === 0x7C || c === 0x21 || // | !
    c === 0x5E || c === 0x40 || // ^ @
    c === 0x23 || c === 0x3F;   // # ?
}

function isAlpha(c: number): boolean {
  return (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c === 0x5F;
}

function isAlnum(c: number): boolean {
  return isAlpha(c) || (c >= 0x30 && c <= 0x39);
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isUpper(c: number): boolean {
  return c >= 0x41 && c <= 0x5A;
}

function startsWith(src: string, needle: string, pos: number): boolean {
  if (needle.length === 0 || pos + needle.length > src.length) return false;
  for (let j = 0; j < needle.length; j++) {
    if (src.charCodeAt(pos + j) !== needle.charCodeAt(j)) return false;
  }
  return true;
}

// Binary search on sorted keyword list
function kwSearch(src: string, start: number, end: number, words: string[]): boolean {
  const len = end - start;
  let lo = 0, hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const w = words[mid]!;
    let cmp = 0;
    const mlen = w.length < len ? w.length : len;
    for (let j = 0; j < mlen; j++) {
      cmp = w.charCodeAt(j) - src.charCodeAt(start + j);
      if (cmp !== 0) break;
    }
    if (cmp === 0) cmp = w.length - len;
    if (cmp < 0) lo = mid + 1;
    else if (cmp > 0) hi = mid - 1;
    else return true;
  }
  return false;
}

function buildHl(src: string, st: HlState, rules: Rules): Uint8Array {
  const len = src.length;
  const hl = new Uint8Array(len); // filled with Normal (0)

  let i = 0;
  let prevSep = true;

  // Resume from multiline state
  if (st.state === State.BlockComment) {
    const close = rules.blockComment[1];
    while (i < len) {
      if (startsWith(src, close, i)) {
        const end = i + close.length;
        hl.fill(Hl.Comment, i, end);
        i = end;
        st.state = State.Normal;
        prevSep = true;
        break;
      }
      hl[i] = Hl.Comment;
      i++;
    }
    if (st.state === State.BlockComment) return hl;
  } else if (st.state === State.MultiLineString) {
    const [, close] = rules.strings[st.stringIdx]!;
    while (i < len) {
      if (src.charCodeAt(i) === 0x5C && i + 1 < len) { // backslash
        hl[i] = Hl.String;
        hl[i + 1] = Hl.String;
        i += 2;
        continue;
      }
      if (startsWith(src, close, i)) {
        const end = i + close.length;
        hl.fill(Hl.String, i, end);
        i = end;
        st.state = State.Normal;
        prevSep = true;
        break;
      }
      hl[i] = Hl.String;
      i++;
    }
    if (st.state === State.MultiLineString) return hl;
  }

  const lineCom = rules.lineComment;
  const blockOpen = rules.blockComment[0];
  const blockClose = rules.blockComment[1];

  while (i < len) {
    // Line comment
    if (lineCom && startsWith(src, lineCom, i)) {
      hl.fill(Hl.Comment, i, len);
      st.state = State.Normal;
      return hl;
    }
    // Block comment
    if (blockOpen && startsWith(src, blockOpen, i)) {
      const start = i;
      i += blockOpen.length;
      let found = false;
      while (i < len) {
        if (startsWith(src, blockClose, i)) {
          hl.fill(Hl.Comment, start, i + blockClose.length);
          i += blockClose.length;
          prevSep = true;
          found = true;
          break;
        }
        i++;
      }
      if (!found) {
        hl.fill(Hl.Comment, start, len);
        st.state = State.BlockComment;
        return hl;
      }
      continue;
    }
    // Strings
    let matched = false;
    for (let di = 0; di < rules.strings.length; di++) {
      const [open, close, multiline] = rules.strings[di]!;
      if (startsWith(src, open, i)) {
        const start = i;
        i += open.length;
        let found = false;
        while (i < len) {
          if (src.charCodeAt(i) === 0x5C && i + 1 < len) { // backslash escape
            i += 2;
            continue;
          }
          if (startsWith(src, close, i)) {
            hl.fill(Hl.String, start, i + close.length);
            i += close.length;
            prevSep = true;
            found = true;
            break;
          }
          i++;
        }
        if (!found) {
          hl.fill(Hl.String, start, len);
          if (multiline) {
            st.state = State.MultiLineString;
            st.stringIdx = di;
          }
          return hl;
        }
        matched = true;
        break;
      }
    }
    if (matched) continue;

    const c = src.charCodeAt(i);

    // Numbers
    if (rules.highlightNumbers && prevSep &&
        (isDigit(c) || (c === 0x2E && i + 1 < len && isDigit(src.charCodeAt(i + 1))))) {
      const start = i;
      i++;
      while (i < len) {
        const d = src.charCodeAt(i);
        if (isAlnum(d) || d === 0x5F || d === 0x2E) i++;
        else break;
      }
      hl.fill(Hl.Number, start, i);
      prevSep = false;
      continue;
    }

    // Keywords / types / identifiers
    if (prevSep && isAlpha(c)) {
      const start = i;
      i++;
      while (i < len && isAlnum(src.charCodeAt(i))) i++;
      const ident = kwSearch(src, start, i, rules.keywords) ? Hl.Keyword
        : kwSearch(src, start, i, rules.types) ? Hl.Type
        : null;
      if (ident !== null) {
        hl.fill(ident, start, i);
        prevSep = false;
        continue;
      }
      // Bang macros (Rust)
      if (rules.highlightBangMacros && i < len &&
          src.charCodeAt(i) === 0x21 && // !
          (i + 1 >= len || src.charCodeAt(i + 1) !== 0x3D)) { // not !=
        hl.fill(Hl.Macro, start, i + 1);
        i++;
        prevSep = true;
        continue;
      }
      // Function calls
      if (rules.highlightFnCalls && i < len && src.charCodeAt(i) === 0x28) { // (
        hl.fill(Hl.Function, start, i);
        prevSep = true;
        continue;
      }
      // UPPER_SNAKE_CASE constants
      if (i - start >= 2) {
        let allUpper = true;
        let hasLetter = false;
        for (let j = start; j < i; j++) {
          const b = src.charCodeAt(j);
          if (isUpper(b)) hasLetter = true;
          else if (!isDigit(b) && b !== 0x5F) { allUpper = false; break; }
        }
        if (allUpper && hasLetter) hl.fill(Hl.Constant, start, i);
      }
      prevSep = false;
      continue;
    }

    // Operators
    matched = false;
    for (let oi = 0; oi < rules.operators.length; oi++) {
      const op = rules.operators[oi]!;
      if (startsWith(src, op, i)) {
        hl.fill(Hl.Operator, i, i + op.length);
        i += op.length;
        prevSep = true;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Brackets
    if (c === 0x28 || c === 0x29 || c === 0x5B || c === 0x5D || c === 0x7B || c === 0x7D) {
      hl[i] = Hl.Bracket;
    }

    prevSep = isSep(c);
    i++;
  }

  st.state = State.Normal;
  return hl;
}

function applyHlHtml(src: string, hl: Uint8Array): string {
  let out = '';
  let cur = Hl.Normal;
  for (let i = 0; i < src.length; i++) {
    const h: Hl = i < hl.length ? hl[i]! : Hl.Normal;
    if (h !== cur) {
      if (cur !== Hl.Normal) out += '</span>';
      const cls = hlClass[h];
      if (cls) out += `<span class="${cls}">`;
      cur = h;
    }
    const c = src.charCodeAt(i);
    if (c === 0x26) out += '&amp;';
    else if (c === 0x3C) out += '&lt;';
    else if (c === 0x3E) out += '&gt;';
    else if (c === 0x22) out += '&quot;';
    else out += src[i];
  }
  if (cur !== Hl.Normal) out += '</span>';
  return out;
}

/// Highlight a full code block (multi-line). Returns HTML with spans.
export function highlightCode(code: string, lang: string): string {
  const rules = rulesForLang(lang);
  if (!rules) return escapeHtmlSimple(code);

  const lines = code.split('\n');
  const st: HlState = { state: State.Normal, stringIdx: 0 };
  const parts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) parts.push('\n');
    const hl = buildHl(lines[i]!, st, rules);
    parts.push(applyHlHtml(lines[i]!, hl));
  }
  return parts.join('');
}

function escapeHtmlSimple(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x26) out += '&amp;';
    else if (c === 0x3C) out += '&lt;';
    else if (c === 0x3E) out += '&gt;';
    else if (c === 0x22) out += '&quot;';
    else out += s[i];
  }
  return out;
}

// Language definitions (keywords sorted for binary search)

const RUST: Rules = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  strings: [['"', '"', false], ["'", "'", false]],
  keywords: [
    'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum',
    'extern', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut',
    'pub', 'ref', 'return', 'self', 'static', 'struct', 'super', 'trait', 'type', 'unsafe',
    'use', 'where', 'while', 'yield',
  ],
  types: [
    'Box', 'Err', 'None', 'Ok', 'Option', 'Result', 'Self', 'Some', 'String', 'Vec', 'bool',
    'char', 'f32', 'f64', 'false', 'i128', 'i16', 'i32', 'i64', 'i8', 'isize', 'str', 'true',
    'u128', 'u16', 'u32', 'u64', 'u8', 'usize',
  ],
  operators: ['&&', '->', '!=', '==', '<=', '>=', '=>', '||'],
  highlightNumbers: true,
  highlightFnCalls: true,
  highlightBangMacros: true,
};

const PYTHON: Rules = {
  lineComment: '#',
  blockComment: ['', ''],
  strings: [['"""', '"""', true], ["'''", "'''", true], ['"', '"', false], ["'", "'", false]],
  keywords: [
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
    'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
    'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with',
    'yield',
  ],
  types: [
    'False', 'None', 'True', 'bool', 'bytes', 'dict', 'float', 'int', 'list', 'self', 'set',
    'str', 'tuple',
  ],
  operators: ['!=', '==', '<=', '>='],
  highlightNumbers: true,
  highlightFnCalls: true,
  highlightBangMacros: false,
};

const GO: Rules = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  strings: [['`', '`', true], ['"', '"', false], ["'", "'", false]],
  keywords: [
    'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough',
    'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range',
    'return', 'select', 'struct', 'switch', 'type', 'var',
  ],
  types: [
    'bool', 'byte', 'complex128', 'complex64', 'error', 'false', 'float32', 'float64',
    'int', 'int16', 'int32', 'int64', 'int8', 'iota', 'nil', 'rune', 'string', 'true',
    'uint', 'uint16', 'uint32', 'uint64', 'uint8', 'uintptr',
  ],
  operators: ['&&', ':=', '!=', '==', '<=', '>=', '||'],
  highlightNumbers: true,
  highlightFnCalls: true,
  highlightBangMacros: false,
};

const TS: Rules = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  strings: [['`', '`', true], ['"', '"', false], ["'", "'", false]],
  keywords: [
    'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally',
    'for', 'from', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface',
    'let', 'new', 'of', 'package', 'private', 'protected', 'public', 'return', 'static',
    'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with',
    'yield',
  ],
  types: [
    'Array', 'Map', 'Promise', 'Set', 'any', 'bigint', 'boolean', 'false', 'never', 'null',
    'number', 'object', 'string', 'symbol', 'true', 'undefined', 'unknown', 'void',
  ],
  operators: ['&&', '!==', '===', '!=', '==', '<=', '>=', '=>', '||'],
  highlightNumbers: true,
  highlightFnCalls: true,
  highlightBangMacros: false,
};

const JS: Rules = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  strings: [['`', '`', true], ['"', '"', false], ["'", "'", false]],
  keywords: [
    'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'from',
    'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'static',
    'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with',
    'yield',
  ],
  types: [
    'Array', 'Boolean', 'Infinity', 'Map', 'NaN', 'Number', 'Object', 'Promise', 'Set',
    'String', 'false', 'null', 'true', 'undefined',
  ],
  operators: ['&&', '!==', '===', '!=', '==', '<=', '>=', '=>', '||'],
  highlightNumbers: true,
  highlightFnCalls: true,
  highlightBangMacros: false,
};

const BASH: Rules = {
  lineComment: '#',
  blockComment: ['', ''],
  strings: [['"', '"', false], ["'", "'", false]],
  keywords: [
    'break', 'case', 'continue', 'declare', 'do', 'done', 'elif', 'else', 'esac', 'eval',
    'exec', 'exit', 'export', 'fi', 'for', 'function', 'if', 'in', 'local', 'readonly',
    'return', 'set', 'shift', 'source', 'then', 'trap', 'unset', 'while',
  ],
  types: ['false', 'true'],
  operators: ['&&', '||'],
  highlightNumbers: true,
  highlightFnCalls: false,
  highlightBangMacros: false,
};

const C: Rules = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  strings: [['"', '"', false], ["'", "'", false]],
  keywords: [
    'auto', 'break', 'case', 'const', 'continue', 'default', 'do', 'else', 'enum', 'extern',
    'for', 'goto', 'if', 'inline', 'register', 'restrict', 'return', 'sizeof', 'static',
    'struct', 'switch', 'typedef', 'union', 'volatile', 'while',
  ],
  types: [
    'NULL', 'bool', 'char', 'double', 'false', 'float', 'int', 'int16_t', 'int32_t', 'int64_t',
    'int8_t', 'long', 'short', 'signed', 'size_t', 'true', 'uint16_t', 'uint32_t', 'uint64_t',
    'uint8_t', 'unsigned', 'void',
  ],
  operators: ['&&', '->', '!=', '==', '<=', '>=', '||'],
  highlightNumbers: true,
  highlightFnCalls: true,
  highlightBangMacros: false,
};

const TOML: Rules = {
  lineComment: '#',
  blockComment: ['', ''],
  strings: [['"""', '"""', true], ["'''", "'''", true], ['"', '"', false], ["'", "'", false]],
  keywords: [],
  types: ['false', 'true'],
  operators: [],
  highlightNumbers: true,
  highlightFnCalls: false,
  highlightBangMacros: false,
};

const JSON_RULES: Rules = {
  lineComment: '',
  blockComment: ['', ''],
  strings: [['"', '"', false]],
  keywords: [],
  types: ['false', 'null', 'true'],
  operators: [],
  highlightNumbers: true,
  highlightFnCalls: false,
  highlightBangMacros: false,
};

const YAML: Rules = {
  lineComment: '#',
  blockComment: ['', ''],
  strings: [['"', '"', false], ["'", "'", false]],
  keywords: [],
  types: ['false', 'null', 'true', 'yes', 'no'],
  operators: [],
  highlightNumbers: true,
  highlightFnCalls: false,
  highlightBangMacros: false,
};

function rulesForLang(tag: string): Rules | null {
  switch (tag.toLowerCase()) {
    case 'rust': case 'rs': return RUST;
    case 'python': case 'py': return PYTHON;
    case 'go': case 'golang': return GO;
    case 'typescript': case 'ts': return TS;
    case 'javascript': case 'js': case 'jsx': case 'tsx': return JS;
    case 'bash': case 'sh': case 'shell': case 'zsh': return BASH;
    case 'c': case 'cpp': case 'c++': case 'h': case 'cc': case 'cxx': return C;
    case 'toml': return TOML;
    case 'json': case 'jsonc': return JSON_RULES;
    case 'yaml': case 'yml': return YAML;
    default: return null;
  }
}
