// The store must move into its own repository with no code changes: every file in this directory (code and tests) imports
// only Node built-ins, the allowed @medplum packages (tests: vitest too) and files inside the directory. The files are
// tokenized (strings, templates, comments and regex literals told apart), so spacing and quoting cannot hide an import.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PACKAGES = ['@medplum/core', '@medplum/fhirtypes', '@medplum/definitions'];
// Where each package resolves (literal specifiers, so this file passes its own scan).
const PKG_ENTRY: Record<string, () => string> = {
  '@medplum/core': () => import.meta.resolve('@medplum/core'),
  '@medplum/fhirtypes': () => import.meta.resolve('@medplum/fhirtypes'),
  '@medplum/definitions': () => import.meta.resolve('@medplum/definitions'),
};

type Tok = { t: 'id' | 'str' | 'tpl' | 'num' | 'regex' | 'punct'; v: string; cond?: boolean }; // cond: a ) closing an if/while/for/with condition
const REGEX_AFTER_ID = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const PUNCT = ['...', '?.', '=>', '===', '!==', '==', '!=', '<=', '>=', '&&', '||', '??', '++', '--'];

export function tokens(code: string): Tok[] {
  const out: Tok[] = [];
  const stack: ('brace' | 'tpl')[] = []; // open braces; 'tpl' marks a ${ inside a template
  const parens: boolean[] = []; // open parens: true when it opens an if/while/for/with condition
  let i = 0;
  // A / starts a regex where an expression can start: after most punctuation, some keywords, and the ) of a statement's
  // condition (`if (x) /re/.test(y)`); after any other ), a ] or a postfix ++/-- it is division.
  const regexOk = () => {
    const p = out.at(-1);
    return !p || (p.t === 'punct' && (p.v === ')' ? !!p.cond : ![']', '++', '--'].includes(p.v))) || (p.t === 'id' && REGEX_AFTER_ID.has(p.v));
  };
  // Reads template text from i (after ` or }) to the closing ` or the next ${; true when it stopped at ${.
  const templateText = (): boolean => {
    for (; i < code.length; i++) {
      if (code[i] === '\\') { i++; continue; }
      if (code[i] === '`') { i++; return false; }
      if (code[i] === '$' && code[i + 1] === '{') { i += 2; return true; }
    }
    return false;
  };
  while (i < code.length) {
    const c = code[i];
    if (/\s/.test(c)) { i++; continue; }
    if (code.startsWith('//', i)) { i = code.indexOf('\n', i); if (i < 0) break; continue; }
    if (code.startsWith('/*', i)) { const e = code.indexOf('*/', i + 2); i = e < 0 ? code.length : e + 2; continue; }
    if (c === '"' || c === "'") {
      let v = '';
      for (i++; i < code.length && code[i] !== c; i++) v += code[i] === '\\' ? code[++i] : code[i];
      i++;
      out.push({ t: 'str', v });
      continue;
    }
    if (c === '`') {
      const start = ++i;
      if (templateText()) { out.push({ t: 'tpl', v: '' }); stack.push('tpl'); } // with ${...}: dynamic
      else out.push({ t: 'str', v: code.slice(start, i - 1) });
      continue;
    }
    if (c === '}' && stack.at(-1) === 'tpl') { stack.pop(); i++; if (templateText()) stack.push('tpl'); continue; }
    if (c === '/' && regexOk()) {
      let cls = false;
      for (i++; i < code.length; i++) {
        if (code[i] === '\\') { i++; continue; }
        if (code[i] === '[') cls = true; else if (code[i] === ']') cls = false; else if (code[i] === '/' && !cls) break;
      }
      for (i++; /[a-z]/.test(code[i] ?? ''); i++);
      out.push({ t: 'regex', v: '' });
      continue;
    }
    const id = /^[A-Za-z_$#][\w$]*/.exec(code.slice(i, i + 200))?.[0];
    if (id) { out.push({ t: 'id', v: id }); i += id.length; continue; }
    const num = /^\d[\w.]*/.exec(code.slice(i, i + 50))?.[0];
    if (num) { out.push({ t: 'num', v: num }); i += num.length; continue; }
    const p = PUNCT.find((x) => code.startsWith(x, i)) ?? c;
    if (p === '{') stack.push('brace');
    if (p === '}') stack.pop();
    if (p === '(') {
      const b = out.at(-1), b2 = out.at(-2);
      parens.push(b?.t === 'id' && (['if', 'while', 'for', 'with'].includes(b.v) || (b.v === 'await' && b2?.v === 'for')));
    }
    out.push({ t: 'punct', v: p, ...(p === ')' && parens.pop() && { cond: true }) });
    i += p.length;
  }
  return out;
}

// Every module or file a file reaches: import/export ... from, side-effect import, import(), require(), import.meta.resolve()
// new URL(<literal>, import.meta.url) (as `url:<literal>`) and new URL(<literal>, import.meta.resolve('<pkg>')) (as
// `pkgurl:<pkg>|<literal>`). Not one literal: `<dynamic>`; any createRequire: `<createRequire>`;
// import.meta.url/dirname/filename used any other way: `<import.meta.path>`.
export function specifiers(code: string): string[] {
  const ts = tokens(code), out: string[] = [];
  const is = (k: number, v: string) => ts[k]?.t !== 'str' && ts[k]?.v === v;
  const lit = (k: number) => (ts[k]?.t === 'str' ? ts[k].v : undefined);
  const call = (k: number) => { const s = lit(k + 1); out.push(s !== undefined && (is(k + 2, ')') || is(k + 2, ',')) ? s : '<dynamic>'); }; // k: the (
  const fromAt = (j: number) => { if (is(j, 'from') && lit(j + 1) !== undefined) out.push(lit(j + 1)!); };
  // The token indexes of each top-level argument of the call whose ( is at k.
  const args = (k: number): number[][] => {
    const list: number[][] = [[]];
    for (let j = k + 1, d = 0; j < ts.length; j++) {
      if (ts[j].t === 'punct' && '([{'.includes(ts[j].v)) d++;
      if (ts[j].t === 'punct' && ')]}'.includes(ts[j].v) && d-- === 0) break;
      if (d === 0 && is(j, ',')) list.push([]); else list.at(-1)!.push(j);
    }
    return list.filter((a) => a.length);
  };
  const seen = new Set<number>(); // an import.meta.url already read as a new URL base
  for (let k = 0; k < ts.length; k++) {
    if (ts[k].t !== 'id' || is(k - 1, '.') || is(k - 1, '?.') || seen.has(k)) continue;
    const v = ts[k].v;
    if (v === 'import' && is(k + 1, '(')) call(k + 1);
    else if (v === 'import' && is(k + 1, '.') && is(k + 2, 'meta') && is(k + 3, '.')) {
      if (is(k + 4, 'resolve') && is(k + 5, '(')) call(k + 5);
      else if (is(k + 4, 'url') || is(k + 4, 'dirname') || is(k + 4, 'filename')) out.push('<import.meta.path>'); // a path that could be walked out of the store
    } else if (v === 'import') {
      if (lit(k + 1) !== undefined) { out.push(lit(k + 1)!); continue; }
      for (let j = k + 1; j < ts.length && !is(j, ';') && !is(j, '='); j++) if (is(j, 'from') && lit(j + 1) !== undefined) { out.push(lit(j + 1)!); break; }
    } else if (v === 'export') {
      let j = k + 1;
      if (is(j, 'type')) j++;
      if (is(j, '*')) { j++; if (is(j, 'as')) j += 2; fromAt(j); }
      else if (is(j, '{')) { let d = 0; for (; j < ts.length; j++) { if (is(j, '{')) d++; if (is(j, '}') && !--d) break; } fromAt(j + 1); }
    } else if (v === 'require' && is(k + 1, '(')) call(k + 1);
    else if (v === 'createRequire') out.push('<createRequire>');
    else if (v === 'new' && is(k + 1, 'URL') && is(k + 2, '(')) {
      const [first, base, ...more] = args(k + 2);
      const one = first?.length === 1 ? lit(first[0]) : undefined;
      const at = (b: number[] | undefined, ...vs: string[]) => b?.length === vs.length && vs.every((x, n) => (x === '<str>' ? lit(b[n]) !== undefined : is(b[n], x)));
      if (more.length) continue;
      if (at(base, 'import', '.', 'meta', '.', 'url')) { out.push(one !== undefined ? `url:${one}` : '<dynamic>'); seen.add(base![0]); }
      else if (at(base, 'import', '.', 'meta', '.', 'resolve', '(', '<str>', ')')) out.push(one !== undefined ? `pkgurl:${lit(base![6])}|${one}` : '<dynamic>');
    }
  }
  return out;
}

// Why a specifier in `file` breaks the boundary, or undefined when it is allowed.
export function violation(spec: string, file: string, root = ROOT): string | undefined {
  const test = file.startsWith(join(root, 'test') + sep);
  if (spec.startsWith('<')) return `${spec.slice(1, -1)}: not a fixed path inside the store`;
  if (spec.startsWith('node:')) return undefined;
  if (spec.startsWith('pkgurl:')) { // must stay inside the package's own directory
    const [pkg, rel] = spec.slice(7).split('|');
    const bad = violation(pkg, file, root);
    if (bad) return bad;
    const entry = fileURLToPath(PKG_ENTRY[pkg]());
    const dir = entry.slice(0, entry.lastIndexOf(`${sep}node_modules${sep}`) + `${sep}node_modules${sep}${pkg}${sep}`.length);
    return fileURLToPath(new URL(rel, pathToFileURL(entry))).startsWith(dir) ? undefined : `leaves ${pkg}`;
  }
  const url = spec.startsWith('url:') ? spec.slice(4) : undefined;
  const rel = url ?? spec;
  if (rel.startsWith('.') || rel.startsWith('/') || url !== undefined) {
    let target: string;
    try { target = fileURLToPath(new URL(rel, pathToFileURL(file))); } catch { return 'leaves the store'; }
    const r = root.endsWith(sep) ? root : root + sep;
    return target === r.slice(0, -1) || target.startsWith(r) ? undefined : 'leaves the store';
  }
  const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  return PACKAGES.includes(pkg) || (test && pkg === 'vitest') ? undefined : 'package not allowed';
}

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.name === 'node_modules' || e.name.startsWith('.') ? []
    : e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|js|mjs|cjs|mts|cts)$/.test(e.name) ? [join(dir, e.name)] : []);

describe('store boundary', () => {
  it('every file in the store directory imports nothing outside the allowlist', () => {
    const bad: string[] = [];
    let n = 0;
    for (const f of files(ROOT)) {
      for (const s of specifiers(readFileSync(f, 'utf8'))) {
        n++;
        const why = violation(s, f);
        if (why) bad.push(`${relative(ROOT, f)}: ${s} (${why})`);
      }
    }
    expect(n).toBeGreaterThan(40); // the scan sees the imports (a broken tokenizer would pass with none)
    expect(bad).toEqual([]);
  });

  it('flags every way out of the directory', () => {
    const f = join(ROOT, 'server.ts');
    const specs = specifiers(readFileSync(join(ROOT, 'test', 'boundary-fixture.txt'), 'utf8')); // not .ts: the scan above skips it
    expect(specs.map((s) => [s, violation(s, f) ?? 'ok'])).toEqual([
      ['../limits.ts', 'leaves the store'],
      ['../config.ts', 'leaves the store'], // import type { X } across lines
      ['./store.ts', 'ok'],
      ['zod', 'package not allowed'],
      ['<dynamic>', 'dynamic: not a fixed path inside the store'],
      ['fs', 'package not allowed'],
      ['@medplum/definitions', 'ok'],
      ['./search.ts', 'ok'],
      ['../config.ts', 'leaves the store'], // import{x}from'../config.ts'
      ['../config.ts', 'leaves the store'], // export*from'../config.ts'
      ['../config.ts', 'leaves the store'], // import type{X}from'../config.ts'
      ['../config.ts', 'leaves the store'], // import { "a'b" as c } from '../config.ts'
      ['<createRequire>', 'createRequire: not a fixed path inside the store'], // createRequire(import.meta.url)('../config.ts')
      ['<import.meta.path>', 'import.meta.path: not a fixed path inside the store'], // its import.meta.url
      ['url:../../config/x.json', 'leaves the store'],
      ['url:./fixtures/a.json', 'ok'],
      ['<dynamic>', 'dynamic: not a fixed path inside the store'], // new URL(name, import.meta.url)
      ['<import.meta.path>', 'import.meta.path: not a fixed path inside the store'],
      ['../config.ts', 'leaves the store'], // export { a } from
      ['../config.ts', 'leaves the store'], // a ${} template's import()
      ['../config.ts', 'leaves the store'], // after if (x) /'/.test(y): a regex, not division
      ['./search.ts', 'ok'], // after (n) / 2 / (m): division
      ['pkgurl:@medplum/definitions|../fhir/r4/', 'ok'],
      ['@medplum/definitions', 'ok'],
      ['pkgurl:@medplum/definitions|../../../../x.json', 'leaves @medplum/definitions'],
      ['@medplum/definitions', 'ok'],
      ['<dynamic>', 'dynamic: not a fixed path inside the store'], // new URL(f, import.meta.resolve(pkg))
      ['@medplum/definitions', 'ok'],
      ['<dynamic>', 'dynamic: not a fixed path inside the store'], // new URL(`../${f}`, import.meta.url)
      ['../x.ts', 'leaves the store'], // after i++ / 2: division
      ['../y.ts', 'leaves the store'], // after arr.length-- / 2: division
    ]);
    expect(violation('vitest', f)).toBe('package not allowed');
    expect(violation('vitest', join(ROOT, 'test', 'x.test.ts'))).toBeUndefined();
    expect(violation('../store.ts', join(ROOT, 'test', 'x.test.ts'))).toBeUndefined();
    expect(violation('../../config.ts', join(ROOT, 'test', 'x.test.ts'))).toBe('leaves the store');
    expect(violation('../store-other/x.ts', f)).toBe('leaves the store'); // a sibling sharing the prefix
    expect(specifiers("const s = '/* import(\"../x.ts\") */'; const r = /\\/*/g; import('./ok.ts');")).toEqual(['./ok.ts']); // strings and regexes are not code
  });
});
