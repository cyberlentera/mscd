// Converts the Claude Design prototype template (project/MSCD Mockup.dc.html at the
// repository root) into React JSX view components under src/views and the hover rules
// in src/hover.css. The views render against the view-model object produced by
// MscdApp.renderVals().
//
//   node scripts/convert-template.mjs [--out <dir>]
//
// --out <dir> writes the views to <dir>/views/ and the hover rules to <dir>/hover.css
// (default: src, relative to apps/web). scripts/check-views.mjs uses it to regenerate
// into a temporary folder and compare.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseDocument } from 'htmlparser2';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcFile = path.resolve(root, '../../project/MSCD Mockup.dc.html');

let args;
try {
  args = parseArgs({ options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true }).values;
} catch (err) {
  console.error(`${err.message}\nUsage: node scripts/convert-template.mjs [--out <dir>]`);
  process.exit(2);
}
if (args.help) {
  console.log('Usage: node scripts/convert-template.mjs [--out <dir>]\n\nWrites <dir>/views/*.jsx and <dir>/hover.css (default dir: src).');
  process.exit(0);
}
// A relative --out is taken from the current directory; the default is apps/web/src.
const outBase = args.out ? path.resolve(args.out) : path.resolve(root, 'src');
const outDir = path.join(outBase, 'views');
const hoverFile = path.join(outBase, 'hover.css');
let html = fs.readFileSync(srcFile, 'utf8');

// Layout fixes applied on top of the design template. Each patch must match exactly once,
// so a change in the template fails the build instead of silently dropping the fix.
const PATCHES = [
  // Framework library: the action column was clipped below ~1400px. Let long lines wrap and scroll as a last resort.
  ['<sc-if value="{{ isFw }}">\n      <div style="background:var(--sur);border:1px solid var(--bd);border-radius:var(--r);overflow:hidden">',
   '<sc-if value="{{ isFw }}">\n      <div style="background:var(--sur);border:1px solid var(--bd);border-radius:var(--r);overflow-x:auto">'],
  ['<span style="display:block;font-size:12px;color:var(--tx3);white-space:nowrap">{{ f.certifier }}</span>',
   '<span style="display:block;font-size:12px;color:var(--tx3)">{{ f.certifier }}</span>'],
  ['margin-top:2px;white-space:nowrap">✓ {{ f.sig }}', 'margin-top:2px">✓ {{ f.sig }}'],
  // Portfolio rows layout: scroll instead of clipping the right-hand columns on narrow screens.
  ['<sc-if value="{{ pfRows }}">\n        <div style="background:var(--sur);border:1px solid var(--bd);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden">',
   '<sc-if value="{{ pfRows }}">\n        <div style="background:var(--sur);border:1px solid var(--bd);border-radius:var(--r);box-shadow:var(--sh);overflow-x:auto">'],
  // Summary tabs: the "65 / 93 ready" sub-label overflowed into the next tab on narrow screens; wrap it under the number.
  ['display:flex;justify-content:space-between;align-items:baseline;gap:6px">', 'display:flex;justify-content:space-between;align-items:baseline;gap:0 6px;flex-wrap:wrap">'],
  // Portfolio cards: long clause names pushed the percentage out of the card; let the name wrap instead.
  ['padding:3px 0"><span style="color:var(--tx2)"><span style="font-family:var(--ffm);font-weight:600;color:var(--tx);margin-right:6px">{{ c.n }}</span>{{ c.title }}</span><span style="font-family:var(--ffm);font-weight:600;color:{{ c.color }}">',
   'padding:3px 0"><span style="color:var(--tx2);min-width:0;overflow-wrap:anywhere"><span style="font-family:var(--ffm);font-weight:600;color:var(--tx);margin-right:6px">{{ c.n }}</span>{{ c.title }}</span><span style="font-family:var(--ffm);font-weight:600;flex:none;color:{{ c.color }}">'],
  // Preparation checklist and cycle completeness: the tick of a done item is drawn on its status colour,
  // so the box border, the due date and the status text get their own colours instead of the tick colour.
  ['border:1.5px solid {{ p.fg }};background:{{ p.bg }};color:{{ p.fg }}', 'border:1.5px solid {{ p.bd }};background:{{ p.bg }};color:{{ p.fg }}'],
  ['<span style="font-size:12.5px;text-align:right;color:{{ p.fg }}">{{ p.due }}</span>', '<span style="font-size:12.5px;text-align:right;color:{{ p.dueFg }}">{{ p.due }}</span>'],
  ['border:1.5px solid {{ c.fg }};background:{{ c.bg }};color:{{ c.fg }}', 'border:1.5px solid {{ c.bd }};background:{{ c.bg }};color:{{ c.fg }}'],
  ['<span style="font-size:12.5px;color:{{ c.fg }};white-space:nowrap;text-align:right">{{ c.st }}', '<span style="font-size:12.5px;color:{{ c.stFg }};white-space:nowrap;text-align:right">{{ c.st }}'],
  // Audit hero: marked so the dark theme can give it a dark surface (styles.css).
  ['<div style="display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,2fr);gap:0;background:var(--tx);color:var(--bg);',
   '<div data-hero="" style="display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,2fr);gap:0;background:var(--tx);color:var(--bg);'],
  // Traceability nodes: long stage names (RISK & OPPORTUNITY) broke out of the narrow node box at 1280 px.
  ['<div style="font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:{{ n.fg }};font-weight:700">{{ n.stage }}</div>',
   '<div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;overflow-wrap:anywhere;color:{{ n.fg }};font-weight:700">{{ n.stage }}</div>'],
  // List footer: "Showing 1 item", not "1 items".
  ['<span>{{ t.showing }} {{ rowCount }} {{ t.items }}</span>', '<span>{{ t.showing }} {{ rowCount }} {{ itemsWord }}</span>'],
  // Modal confirm button can be disabled (Reassign without a due date).
  ['<button onClick="{{ modalOk }}" style=', '<button onClick="{{ modalOk }}" disabled="{{ modal.okOff }}" style='],
  // The MSCD wordmark keeps the self-hosted brand typeface, so an alternative reading font (or its system
  // fallback when Google Fonts is unreachable, as on-premise) cannot push it out of the sidebar.
  ['<div style="font-weight: 700; letter-spacing: .02em; font-size: 22px">MSCD</div>',
   '<div style="font-weight: 700; letter-spacing: .02em; font-size: 22px; font-family: \'IBM Plex Sans\', system-ui, sans-serif">MSCD</div>'],
  // Hard-coded labels become translation keys.
  ['>Organisation</span>', '>{{ t.organisation }}</span>'],
  ['title="Collapse"', 'title="{{ t.collapse }}"'],
  ['title="Expand"', 'title="{{ t.expand }}"'],
  ['>Framework Pack<br>', '>{{ t.frameworkPack }}<br>'],
  ['title="Theme"', 'title="{{ t.theme }}"'],
  ['>Management system</th>', '>{{ t.c_msName }}</th>'],
  ['>GATE</span>', '>{{ t.gateTag }}</span>', 2],
  ['>PDF, XLSX, DOCX, PNG, max 50 MB, SHA-256 computed on upload<', '>{{ t.uploadHint }}<'],
];
for (const [from, to, times = 1] of PATCHES) {
  const n = html.split(from).length - 1;
  if (n !== times) throw new Error(`template patch matched ${n} times instead of ${times}: ${from.slice(0, 90)}`);
  html = html.split(from).join(to);
}

const tplStart = html.indexOf('<div class="mscd"');
const tplEnd = html.lastIndexOf('</x-dc>');
const tpl = html.slice(tplStart, tplEnd);

// Comment marker (or tag) -> component name. Element right after a marker becomes its own view.
const SPLITS = {
  'Sidebar': 'Sidebar', 'page header': 'PageHeader', 'Portfolio': 'Portfolio',
  'Storage repositories': 'Storage', 'summary cards as tabs': 'SummaryTabs',
  'traceability test (Audit readiness)': 'TraceTest', 'Golden Thread Viewer': 'GoldenThread',
  'Certification timeline': 'Timeline', 'page-pattern detail': 'PageDetail',
  'pending per person': 'PendingPeople', 'Implementation overview': 'Overview',
  'My Tasks': 'MyTasks', 'Framework library': 'FrameworkLibrary',
  'Generic drill-down screen (Module 1 controls, Module 2 chain, Module 3 freshness)': 'DrillScreen',
  'Drawer (panel pattern)': 'Drawer', 'Modals': 'Modals',
};
const TAG_SPLITS = { header: 'TopBar' };

const doc = parseDocument(tpl, { lowerCaseAttributeNames: false, lowerCaseTags: true, recognizeSelfClosing: true, decodeEntities: true });

const hoverRules = [];
const components = {};
const NO_WS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'select', 'colgroup', 'svg', 'g', 'defs', 'ol', 'ul']);
const VOID = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'col', 'source']);
const ATTR_MAP = { class: 'className', for: 'htmlFor', colspan: 'colSpan', rowspan: 'rowSpan', tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength', autocomplete: 'autoComplete', viewbox: 'viewBox' };
const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function expr(p, scope) {
  p = p.trim();
  const parts = p.split('.');
  const head = scope.includes(parts[0]) ? parts[0] : 'v.' + parts[0];
  return [head, ...parts.slice(1)].join('?.');
}
function interp(raw, scope) {
  const whole = raw.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/);
  if (whole) return { whole: true, js: expr(whole[1], scope) };
  if (!raw.includes('{{')) return { whole: false, lit: raw };
  const parts = raw.split(/\{\{([\s\S]+?)\}\}/g);
  const js = '`' + parts.map((s, i) => i & 1 ? '${' + expr(s, scope) + ' ?? \'\'}' : s.replace(/[`\\]/g, '\\$&').replace(/\$\{/g, '\\${')).join('') + '`';
  return { whole: false, js };
}
function styleObj(raw, scope) {
  const decls = [];
  let depth = 0, cur = '';
  for (const ch of raw) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === ';' && depth === 0) { decls.push(cur); cur = ''; } else cur += ch;
  }
  decls.push(cur);
  const props = [];
  for (const d of decls) {
    const i = d.indexOf(':');
    if (i < 0 || !d.trim()) continue;
    const k = d.slice(0, i).trim(); const val = d.slice(i + 1).trim();
    const key = k.startsWith('--') ? JSON.stringify(k) : camel(k.replace(/^-ms-/, 'ms-'));
    const r = interp(val, scope);
    props.push(key + ': ' + (r.js ? (r.whole ? r.js : r.js) : JSON.stringify(r.lit)));
  }
  return '{{ ' + props.join(', ') + ' }}';
}
function attrs(el, scope) {
  const out = [];
  const hover = el.attribs['style-hover'];
  let cls = null, extraStyle = '';
  if (hover) {
    // Hover states become CSS classes; bound values pass through custom properties.
    cls = 'hv' + hoverRules.length;
    const decls = hover.split(';').filter(x => x.trim()).map((d, i) => {
      const [k, ...rest] = d.split(':'); let val = rest.join(':').trim();
      if (val.includes('{{')) { const varName = `--${cls}-${i}`; extraStyle += `;${varName}:${val}`; val = `var(${varName})`; }
      return `${k.trim()}:${val} !important`;
    });
    hoverRules.push(`.${cls}:hover{${decls.join(';')}}`);
  }
  for (const [name, value] of Object.entries(el.attribs)) {
    if (name.startsWith('hint-') || name === 'style-hover') continue;
    if (name === 'style') { out.push('style=' + styleObj(value + extraStyle, scope)); extraStyle = ''; continue; }
    let key = ATTR_MAP[name.toLowerCase()] || name;
    if (/^on[a-z]/.test(key)) key = 'on' + key[2].toUpperCase() + key.slice(3);
    if (key.includes('-') && !key.startsWith('data-') && !key.startsWith('aria-')) key = camel(key);
    const r = interp(value, scope);
    if (r.whole) out.push(`${key}={${r.js}${key === 'value' ? " ?? ''" : ''}}`);
    else if (r.js) out.push(`${key}={${r.js}}`);
    else out.push(`${key}=${JSON.stringify(r.lit)}`);
  }
  if (extraStyle) out.push('style=' + styleObj(extraStyle, scope));
  if (cls) out.push(`className="${cls}"`);
  return out.length ? ' ' + out.join(' ') : '';
}
function textNode(t, scope, parentTag) {
  if (!t.includes('{{')) {
    if (!t.trim()) return (NO_WS.has(parentTag) || !t.includes(' ')) ? '' : '{" "}';
    return '{' + JSON.stringify(t.replace(/\s+/g, ' ')) + '}';
  }
  const parts = t.split(/\{\{([\s\S]+?)\}\}/g);
  return parts.map((p, i) => i & 1 ? `{txt(${expr(p, scope)})}` : (p ? '{' + JSON.stringify(p.replace(/\s+/g, ' ')) + '}' : '')).join('');
}

const INLINE = new Set(['span', 'a', 'b', 'i', 'em', 'strong', 'code', 'button', 'img', 'svg', 'input', 'select', 'label', 'small', 'sub', 'sup', 'br']);
// Is this node rendered as inline content? Control-flow wrappers take their first element child.
function isInline(n) {
  if (!n) return false;
  if (n.type === 'text') return !!n.data.trim();
  if (n.type !== 'tag') return false;
  if (n.name === 'sc-if' || n.name === 'sc-for') return isInline(n.children.find(c => c.type === 'tag' || (c.type === 'text' && c.data.trim())));
  return INLINE.has(n.name);
}
// outer: the siblings around a control-flow wrapper (sc-if, sc-for), so whitespace at the start or end
// of its body still separates it from the inline content next to the wrapper ("items. <button>").
function children(nodes, scope, parentTag, ind, outer = {}) {
  let out = ''; let pending = null;
  const real = nodes.filter(n => n.type !== 'comment');
  const prevOf = i => (i > 0 ? real[i - 1] : outer.prev);
  const nextOf = i => (i < real.length - 1 ? real[i + 1] : outer.next);
  for (const n of nodes) {
    if (n.type === 'comment') { const k = n.data.replace(/=+/g, '').trim(); if (SPLITS[k]) pending = SPLITS[k]; continue; }
    if (n.type === 'text' && !n.data.trim()) {
      // Whitespace only renders as a space between two inline siblings.
      const i = real.indexOf(n);
      if (!NO_WS.has(parentTag) && n.data.includes(' ') && isInline(prevOf(i)) && isInline(nextOf(i))) out += '{" "}';
      continue;
    }
    if (n.type === 'text') { out += textNode(n.data, scope, parentTag); continue; }
    if (n.type !== 'tag') continue;
    const split = pending || (TAG_SPLITS[n.name] && !components[TAG_SPLITS[n.name]] ? TAG_SPLITS[n.name] : null);
    pending = null;
    if (split) {
      if (scope.length) throw new Error('split inside loop: ' + split);
      const body = node(n, scope, '    ');
      components[split] = body.startsWith('{') ? '<>' + body + '</>' : body;
      out += '\n' + ind + `<${split} v={v} />`;
      continue;
    }
    const i = real.indexOf(n);
    out += '\n' + ind + node(n, scope, ind, { parentTag, prev: prevOf(i), next: nextOf(i) });
  }
  return out;
}
let loopId = 0;
function node(el, scope, ind, ctx = {}) {
  const tag = el.name;
  // A control-flow body sits inside the enclosing element, so it inherits that element's whitespace rules.
  const flow = { prev: ctx.prev, next: ctx.next };
  const flowTag = ctx.parentTag || 'frag';
  if (tag === 'sc-if') {
    const r = interp(el.attribs.value, scope);
    return `{${r.js} ? (<>${children(el.children, scope, flowTag, ind + '  ', flow)}\n${ind}</>) : null}`;
  }
  if (tag === 'sc-for') {
    const r = interp(el.attribs.list, scope); const as = el.attribs.as || 'item'; const idx = '$i' + (loopId++);
    return `{list(${r.js}).map((${as}, ${idx}) => (<Fragment key={${idx}}>${children(el.children, [...scope, as], flowTag, ind + '  ')}\n${ind}</Fragment>))}`;
  }
  const a = attrs(el, scope);
  if (VOID.has(tag)) return `<${tag}${a} />`;
  const kids = children(el.children, scope, tag, ind + '  ');
  return `<${tag}${a}>${kids}${kids.includes('\n') ? '\n' + ind : ''}</${tag}>`;
}

fs.mkdirSync(outDir, { recursive: true });
const rootEl = doc.children.filter(n => n.type === 'tag');
const appBody = rootEl.map(n => node(n, [], '    ')).join('\n    ');
const header = (name) => `// Generated from the design prototype by scripts/convert-template.mjs.\nimport { Fragment } from 'react';\nimport { txt, list } from './util.js';\n`;
const importsFor = body => Object.keys(components).filter(c => new RegExp(`<${c} `).test(body)).map(c => `import ${c} from './${c}.jsx';`).join('\n');
for (const [name, body] of Object.entries(components)) {
  fs.writeFileSync(path.join(outDir, name + '.jsx'), `${header(name)}${importsFor(body)}\n\nexport default function ${name}({ v }) {\n  return (\n    ${body}\n  );\n}\n`);
}
fs.writeFileSync(path.join(outDir, 'AppView.jsx'), `${header('AppView')}${importsFor(appBody)}\n\nexport default function AppView({ v }) {\n  return (\n    <>\n    ${appBody}\n    </>\n  );\n}\n`);
fs.writeFileSync(hoverFile, '/* Generated: hover states from the design prototype */\n' + hoverRules.join('\n') + '\n');
console.log('views:', ['AppView', ...Object.keys(components)].join(', '), '| hover rules:', hoverRules.length);
