// solve.js — a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build returns for the same input:
// a JSON object of every path it writes and that file's text, byte for byte. The behaviour is
// makefun-site's own (its README states it, its code decides where they differ); this file is an
// independent reimplementation of that behaviour, written for speed:
//
//   - HTML escaping works on whole runs of text, not one character at a time.
//   - Markdown is rendered in a single pass over the lines, with an inline renderer that works on
//     index ranges instead of slicing substrings for every strong/em/link nest.
//   - Templates are parsed once per case and rendered into one shared output array, with a scope
//     stack instead of a chain of scope objects, and one scope object reused per for-loop.
//   - Slugs are cached within a run, with a fast path for plain ASCII titles.
//   - Word counts are a single scan, not a regex match that builds an array of every word.
//
// Nothing is cached from one case to the next: every cache is created inside run().

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " ' (README.md). */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/**
 * Append s[a..b] to `out`, HTML-escaped. ESC_RE is only ever used here, never re-entrantly, and
 * its lastIndex is reset on every exit, so the shared regex is safe.
 */
function escInto(out, s, a, b) {
  ESC_RE.lastIndex = a;
  let seg = a;
  let m;
  while ((m = ESC_RE.exec(s)) !== null) {
    if (m.index >= b) break;
    if (m.index > seg) out.push(s.slice(seg, m.index));
    out.push(ESCAPES[m[0]]);
    seg = m.index + 1;
  }
  ESC_RE.lastIndex = 0;
  if (b > seg) out.push(s.slice(seg, b));
}

/** `s` with & < > " and ' escaped. A string with nothing to escape comes back as itself. */
function escStr(s) {
  const out = [];
  escInto(out, s, 0, s.length);
  return out.length === 0 ? '' : out.length === 1 ? out[0] : out.join('');
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** The slug of `text`, the slow path (any text): NFKD, combining marks dropped, the rest as stated. */
function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** The slug of an ASCII-only `text`: NFKD is the identity there and no mark can occur. */
function slugifyAscii(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

const NON_ASCII = /[^\x00-\x7f]/;

/** A slug function with a cache that lives only for one run() call. */
function makeSlugify() {
  const cache = new Map();
  return function slugify(text) {
    let r = cache.get(text);
    if (r === undefined) {
      r = NON_ASCII.test(text) ? slugifySlow(text) : slugifyAscii(text);
      cache.set(text, r);
    }
    return r;
  };
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether a UTF-16 code unit is whitespace, by JavaScript's \s set. */
function isSpaceCode(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279
  );
}

/** The ASCII whitespace codes, for the fast path of wordsOf. */
const ASCII_SPACE = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) ASCII_SPACE[c] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const sp = c < 128 ? ASCII_SPACE[c] === 1 : isSpaceCode(c);
    if (sp) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;
const FM_TRAIL = /[ \t]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends. The lines are walked by index instead of split into an array, and the body
 * is the text after the closing line, which is the same string split-and-join would build.
 */
function parseFrontMatter(text) {
  if (!text.startsWith('---') || (text.length !== 3 && text[3] !== '\n')) return { error: 'no front matter' };
  let close = -1; // index of the '\n' just before the closing '---' line
  let at = 0;
  while (true) {
    const idx = text.indexOf('\n---', at);
    if (idx === -1) break;
    const after = idx + 4;
    if (after === text.length || text[after] === '\n') {
      close = idx;
      break;
    }
    at = idx + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineStart = 4; // just after the opening '---\n'
  let lineNo = 2;
  while (lineStart <= close) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1 || lineEnd > close) lineEnd = close;
    const line = text.slice(lineStart, lineEnd);
    if (!FM_BLANK.test(line) && !line.startsWith('#')) {
      const m = LINE.exec(line);
      if (!m) return { error: `line ${lineNo} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(FM_TRAIL, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    lineStart = lineEnd + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = close + 4 < text.length && text[close + 4] === '\n' ? text.slice(close + 5) : '';
  return { data, body };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;
const TAG_STANDALONE = /^[ \t]*$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = TAG_STANDALONE.test(src.slice(lineStart, open)) && TAG_STANDALONE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope stack: its first name from the nearest scope holding it, then own properties. */
function lookup(scopes, path) {
  for (let s = scopes.length - 1; s >= 0; s--) {
    const vars = scopes[s];
    if (Object.hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out`, in the scope stack `scopes`. `ctx` holds the parsed templates and
 * the include depth. A for-loop reuses one scope object across its iterations (its fields are
 * rewritten per item); a loop variable named "loop" falls back to fresh objects per item, exactly
 * as the reference's per-item object literal would read.
 */
function renderNodes(nodes, scopes, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const s = textOf(lookup(scopes, n.path));
        escInto(out, s, 0, s.length);
        break;
      }
      case 'raw':
        out.push(textOf(lookup(scopes, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scopes, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scopes, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scopes, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        if (n.name === 'loop') {
          for (let k = 0; k < len; k++) {
            const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
            scopes.push(vars);
            renderNodes(n.body, scopes, ctx, depth, out);
            scopes.pop();
          }
          break;
        }
        const vars = { [n.name]: undefined, loop: { index: 0, first: true, last: false, length: len } };
        scopes.push(vars);
        const lp = vars.loop;
        for (let k = 0; k < len; k++) {
          vars[n.name] = xs[k];
          lp.index = k + 1;
          lp.first = k === 0;
          lp.last = k === len - 1;
          renderNodes(n.body, scopes, ctx, depth, out);
        }
        scopes.pop();
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scopes, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const HAS_WS = /\s/;

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const c = line.charCodeAt(0);
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR.test(line);
  if (line === '' || c === 32 || c === 9) return BLANK.test(line);
  return false;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. Never past `to`. */
function findUnescaped(s, what, from, to) {
  for (let j = from; j <= to - what.length; j++) {
    if (s[j] === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. Never past `to`. */
function findSingleStar(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < to && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The first index at or after `from` where `s` holds a character that can open an inline construct, or `to`. */
function nextSpecial(s, from, to) {
  let j = to;
  let k = s.indexOf('\\', from);
  if (k !== -1 && k < j) j = k;
  k = s.indexOf('`', from);
  if (k !== -1 && k < j) j = k;
  k = s.indexOf('*', from);
  if (k !== -1 && k < j) j = k;
  k = s.indexOf('[', from);
  if (k !== -1 && k < j) j = k;
  return j;
}

/**
 * The range s[a..b] rendered inline into `out`; `env.link(target)` is a link's href. Plain runs are
 * escaped in bulk; only the constructs below break a run. The scan jumps from one construct opener
 * to the next, so ordinary characters cost no per-character work. The range bounds make every
 * search behave exactly as the reference's whole-string scans do on the same text.
 */
function inlineInto(s, a, b, out, env) {
  let i = a;
  let seg = a;
  while (true) {
    const j = nextSpecial(s, i, b);
    if (j >= b) break;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < b && ESCAPABLE.has(s[j + 1])) {
        if (j > seg) escInto(out, s, seg, j);
        escInto(out, s, j + 1, j + 2); // reference: escapeHtml(s[i + 1]) — '>' is escapable and must become &gt;
        i = j + 2;
        seg = i;
      } else {
        i = j + 1; // a backslash before anything else is itself, and stays in the run
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        if (j > seg) escInto(out, s, seg, j);
        out.push('<code>');
        escInto(out, s, j + 1, k);
        out.push('</code>');
        i = k + 1;
        seg = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (j + 1 < b && s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, b);
        if (k > j + 2) {
          if (j > seg) escInto(out, s, seg, j);
          out.push('<strong>');
          inlineInto(s, j + 2, k, out, env);
          out.push('</strong>');
          i = k + 2;
          seg = i;
        } else {
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1, b);
      if (k > j + 1) {
        if (j > seg) escInto(out, s, seg, j);
        out.push('<em>');
        inlineInto(s, j + 1, k, out, env);
        out.push('</em>');
        i = k + 1;
        seg = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    const k = findUnescaped(s, ']', j + 1, b);
    const m = k !== -1 && k + 1 < b && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 || m >= b ? '' : s.slice(k + 2, m);
    if (target !== '' && !HAS_WS.test(target)) {
      if (j > seg) escInto(out, s, seg, j);
      const href = env.link(target);
      out.push('<a href="');
      escInto(out, href, 0, href.length);
      out.push('">');
      inlineInto(s, j + 1, k, out, env);
      out.push('</a>');
      i = m + 1;
      seg = i;
      continue;
    }
    i = j + 1;
  }
  if (b > seg) escInto(out, s, seg, b);
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first
 * paragraph's inline HTML, or ""). `slugify` is the run's cached slug function.
 */
function renderMarkdown(src, env, slugify) {
  const lines = src.split('\n');
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const block = () => {
    out.push('\n');
  };
  /** One list block, from its first line: `start` is its first item's number (1 for bullets). */
  const listBlock = (isOrdered, start) => {
    const marker = isOrdered ? ORDERED : BULLET;
    const items = [];
    while (i < lines.length) {
      const m = marker.exec(lines[i]);
      if (m !== null) {
        items.push([trimLine(isOrdered ? m[2] : m[1])]);
        i++;
      } else if (CONTINUED.test(lines[i])) {
        items[items.length - 1].push(trimLine(lines[i]));
        i++;
      } else break;
    }
    const tag = isOrdered ? 'ol' : 'ul';
    if (isOrdered && start !== 1) out.push(`<ol start="${start}">`);
    else out.push(`<${tag}>`);
    out.push('\n');
    for (let q = 0; q < items.length; q++) {
      const item = items[q].join('\n');
      out.push('<li>');
      inlineInto(item, 0, item.length, out, env);
      out.push('</li>\n');
    }
    out.push(`</${tag}>`);
    block();
  };
  // Each block kind can only open on lines starting with its own characters, so the first
  // character dispatches, and a line that matches no kind falls through to a paragraph.
  while (i < lines.length) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (line === '' || c0 === 32 || c0 === 9) {
      if (BLANK.test(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < lines.length && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        out.push('<pre><code');
        if (fence[1] !== '') {
          out.push(' class="language-');
          out.push(escStr(fence[1]));
          out.push('"');
        }
        out.push('>');
        for (let q = 0; q < body.length; q++) {
          escInto(out, body[q], 0, body[q].length);
          out.push('\n');
        }
        out.push('</code></pre>');
        block();
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const hOut = [];
        inlineInto(heading.text, 0, heading.text.length, hOut, env);
        const html = hOut.join('');
        out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        block();
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) {
        out.push('<hr>');
        block();
        i++;
        continue;
      }
      const bullet = BULLET.exec(line);
      if (bullet !== null) {
        listBlock(false, 1);
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(/^> ?/, ''));
      const inner = [];
      for (let q = 0; q < body.length; q++) {
        const t = trimLine(body[q]);
        if (t !== '') inner.push(t);
      }
      if (inner.length === 0) {
        out.push('<blockquote>\n</blockquote>');
      } else {
        const joined = inner.join('\n');
        out.push('<blockquote>\n<p>');
        inlineInto(joined, 0, joined.length, out, env);
        out.push('</p>\n</blockquote>');
      }
      block();
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = ORDERED.exec(line);
      if (ordered !== null) {
        listBlock(true, Number(ordered[1]));
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const htmlOut = [];
    inlineInto(text, 0, text.length, htmlOut, env);
    const html = htmlOut.join('');
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>`);
    block();
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CRLF = /\r\n?/g;

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A page's link record as templates read it. */
function linkOf(s) {
  return s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugify = makeSlugify();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(CRLF, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  // The checks run in order, and the first one that fails is the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  // Link targets repeat across a site's bodies; resolving a (directory, target) pair twice is waste.
  const rpCache = new Map();
  const resolveCached = (dir, rel) => {
    const key = `${dir}\0${rel}`;
    let p = rpCache.get(key);
    if (p === undefined) {
      p = resolvePath(dir, rel);
      rpCache.set(key, p);
    }
    return p;
  };
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolveCached(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  // A source's card is built once here and shared by its page and by every list that shows it.
  for (const s of kept) {
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }
  /** A page as its layout reads it. */
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  /** A tag as templates read it (its posts as cards). */
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, [{ site, tags: allTags, recent, ...vars }], ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
