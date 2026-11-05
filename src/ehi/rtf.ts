// Destinations whose content is not document text.
const SKIP = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'headerf', 'headerl', 'headerr', 'footer', 'footerf', 'footerl', 'footerr',
  'listtable', 'listoverridetable', 'revtbl', 'rsidtbl', 'generator', 'xmlnstbl', 'themedata', 'colorschememapping', 'datastore',
  'latentstyles', 'fldinst', 'shpinst', 'nonshppict', 'object',
]);
const BREAK: Record<string, string> = { par: '\n', line: '\n', sect: '\n', page: '\n', row: '\n', tab: '\t', cell: '\t', nestcell: '\t', emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', bullet: '•' };
const cp1252 = new TextDecoder('windows-1252');

// Plain text of an RTF document: control words and non-text groups dropped, \uN and \'hh escapes decoded.
// shortcut: tables become tab/newline-separated text and images are dropped; only code page 1252 hex escapes (all the export uses).
export function rtfToText(rtf: string): string {
  const out: string[] = [];
  const stack: { skip: boolean; uc: number }[] = [];
  let st = { skip: false, uc: 1 };
  let pending = 0; // fallback characters still to skip after a \uN
  let hex: number[] = [];
  const flushHex = () => {
    if (hex.length && !st.skip) out.push(cp1252.decode(Uint8Array.from(hex)));
    hex = [];
  };
  const emit = (s: string) => {
    flushHex();
    if (!st.skip) out.push(s);
  };
  const re = /\\([a-zA-Z]+)(-?\d+)? ?|\\'([0-9a-fA-F]{2})|\\([^a-zA-Z])|([{}])|[\r\n]+|([^\\{}\r\n]+)/g;
  for (const m of rtf.matchAll(re)) {
    const [, word, num, hx, sym, brace, text] = m;
    if (pending && (hx || text)) {
      // The fallback after \uN: `uc` characters, a hex escape counting as one.
      const n = text ? Math.min(pending, text.length) : 1;
      pending -= n;
      if (text && text.length > n) emit(text.slice(n));
      continue;
    }
    pending = 0;
    if (hx) {
      if (!st.skip) hex.push(parseInt(hx, 16));
    } else if (brace === '{') {
      flushHex();
      stack.push(st);
      st = { ...st };
    } else if (brace === '}') {
      flushHex();
      st = stack.pop() ?? { skip: false, uc: 1 };
    } else if (sym) {
      if (sym === '*') st.skip = true;
      else if (sym === '~') emit(' ');
      else if (sym === '_') emit('‑');
      else if ('\\{}'.includes(sym)) emit(sym);
      // \- (optional hyphen), \<newline> and others: nothing
    } else if (word) {
      if (word === 'u' && num) {
        const n = Number(num);
        emit(String.fromCharCode(n < 0 ? n + 65536 : n));
        pending = st.uc;
      } else if (word === 'uc' && num) st.uc = Number(num);
      else if (SKIP.has(word)) st.skip = true;
      else if (BREAK[word]) emit(BREAK[word]);
    } else if (text) emit(text);
    // bare CR/LF in the source are not text
  }
  flushHex();
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
