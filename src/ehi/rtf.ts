// Destinations whose content is not document text.
const SKIP = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'headerf', 'headerl', 'headerr', 'footer', 'footerf', 'footerl', 'footerr',
  'listtable', 'listoverridetable', 'revtbl', 'rsidtbl', 'generator', 'xmlnstbl', 'themedata', 'colorschememapping', 'datastore',
  'latentstyles', 'fldinst', 'shpinst', 'nonshppict', 'object',
]);
const BREAK: Record<string, string> = { par: '\n', line: '\n', sect: '\n', page: '\n', row: '\n', tab: '\t', cell: '\t', nestcell: '\t', emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', bullet: '•' };
// \ansicpgN code pages and \fcharsetN font charsets, as TextDecoder labels.
const CODEPAGE: Record<string, string> = { 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258' };
const CHARSET: Record<string, string> = { 128: 'shift_jis', 129: 'euc-kr', 134: 'gbk', 136: 'big5', 161: 'windows-1253', 162: 'windows-1254', 177: 'windows-1255', 178: 'windows-1256', 186: 'windows-1257', 204: 'windows-1251', 222: 'windows-874', 238: 'windows-1250' };

type State = { skip: boolean; uc: number; font?: string };

// Plain text of an RTF document: control words and non-text groups dropped, \uN and \'hh escapes decoded (\'hh in the
// document's \ansicpg, or in the current font's \fcharset when it names one), \binN payloads skipped.
// shortcut: tables become tab/newline-separated text and images are dropped; upgrade if notes need table layout.
export function rtfToText(rtf: string): string {
  const docCp = new TextDecoder(CODEPAGE[/\\ansicpg(\d+)/.exec(rtf)?.[1] ?? ''] ?? 'windows-1252');
  const fontCs = new Map<string, TextDecoder>();
  for (const m of rtf.matchAll(/\\f(\d+)(?:\\[a-z]+-?\d* ?)*?\\fcharset(\d+)/g)) if (CHARSET[m[2]]) fontCs.set(m[1], new TextDecoder(CHARSET[m[2]]));
  const out: string[] = [];
  const stack: State[] = [];
  let st: State = { skip: false, uc: 1 };
  let pending = 0; // fallback characters still to skip after a \uN
  let hex: number[] = [];
  const flushHex = () => {
    if (hex.length && !st.skip) out.push(((st.font && fontCs.get(st.font)) || docCp).decode(Uint8Array.from(hex)));
    hex = [];
  };
  const emit = (text: string) => {
    flushHex();
    if (!st.skip) out.push(text);
  };
  const re = /\\([a-zA-Z]+)(-?\d+)? ?|\\'([0-9a-fA-F]{2})|\\([^a-zA-Z])|([{}])|[\r\n]+|([^\\{}\r\n]+)/g;
  for (let m = re.exec(rtf); m; m = re.exec(rtf)) {
    const [, word, num, hx, sym, brace, text] = m;
    if (!word && !hx && !sym && !brace && !text) continue; // bare CR/LF in the source: not text, not a fallback char
    if (pending && !brace) {
      // The fallback after \uN: `uc` characters; a hex escape or a control word counts as one. A group end stops it.
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
      else if (sym === '~') emit('\u00A0');
      else if (sym === '_') emit('\u2011');
      else if ('\\{}'.includes(sym)) emit(sym);
      // \- (optional hyphen), \<newline> and others: nothing
    } else if (word) {
      if (word === 'u' && num) {
        const n = Number(num);
        emit(String.fromCharCode(n < 0 ? n + 65536 : n));
        pending = st.uc;
      } else if (word === 'uc' && num) st.uc = Number(num);
      else if (word === 'bin' && num) re.lastIndex += Number(num); // binary payload
      else if (word === 'upr') st.skip = true; // ANSI copy; its \ud group carries the Unicode one
      else if (word === 'ud') st.skip = false;
      else if (word === 'f' && num) {
        flushHex();
        st.font = num;
      } else if (SKIP.has(word)) st.skip = true;
      else if (BREAK[word]) emit(BREAK[word]);
    } else if (text) emit(text);
  }
  flushHex();
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
