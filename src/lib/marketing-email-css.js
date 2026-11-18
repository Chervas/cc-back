'use strict';

// Authored CSS never leaves the imported-message subtree. PostCSS parses the
// stylesheet/declarations; selectors intentionally support only email tags,
// classes, descendant/child combinators, and width media conditions.
const postcss = require('postcss');
const SCOPE_CLASS = 'cc-email-imported';
const SCOPE = `.${SCOPE_CLASS}`;
const CLASS_PREFIX = 'cc-e-';
const MAX_CSS_BYTES = 32 * 1024;
const COLOR = /^(?:#[a-f\d]{3,8}|[a-z]+|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/i;
const SIZE = /^(?:0|\d+(?:\.\d+)?(?:px|em|rem|%|pt)|auto)$/;
const SIZES = /^(?:0|\d+(?:\.\d+)?(?:px|em|rem|%|pt)|auto)(?:\s+(?:0|\d+(?:\.\d+)?(?:px|em|rem|%|pt)|auto)){0,3}$/;
const STYLES = {
  color: [COLOR], 'background-color': [COLOR], background: [COLOR],
  width: [SIZE], height: [SIZE], 'max-width': [SIZE], 'min-width': [SIZE], 'max-height': [SIZE], 'min-height': [SIZE],
  margin: [SIZES], padding: [SIZES],
  'font-family': [/^[a-zA-Z0-9 ,"'-]+$/], 'font-size': [SIZE],
  'font-weight': [/^(?:normal|bold|[1-9]00)$/], 'font-style': [/^(?:normal|italic)$/],
  font: [/^(?:(?:normal|italic|bold|[1-9]00)\s+)*\d+(?:\.\d+)?(?:px|pt|em|rem)(?:\/(?:\d+(?:\.\d+)?(?:px|pt|em|rem|%)?))?\s+[a-zA-Z0-9 ,"'-]+$/],
  'line-height': [/^(?:normal|\d+(?:\.\d+)?(?:px|pt|em|rem|%)?)$/],
  'letter-spacing': [SIZE], 'text-align': [/^(?:left|right|center|justify)$/],
  'text-decoration': [/^(?:none|underline|line-through)$/], 'vertical-align': [/^(?:top|middle|bottom|baseline)$/],
  'white-space': [/^(?:normal|pre-line|pre-wrap|nowrap)$/],
  display: [/^(?:block|inline|inline-block|table|table-row|table-cell|none)$/],
  'border-collapse': [/^(?:collapse|separate)$/], 'border-spacing': [SIZES],
  'border-radius': [SIZES], border: [/^(?:0|none|\d+(?:px|pt)\s+(?:solid|dashed|dotted)\s+(?:#[a-f\d]{3,8}|[a-z]+))$/i],
  'box-sizing': [/^(?:border-box|content-box)$/], 'table-layout': [/^(?:auto|fixed)$/],
  'overflow-wrap': [/^(?:normal|anywhere|break-word)$/], 'word-break': [/^(?:normal|break-all|keep-all|break-word)$/],
  '-webkit-text-size-adjust': [/^(?:none|100%)$/], '-ms-text-size-adjust': [/^(?:none|100%)$/],
};
for (const side of ['top', 'right', 'bottom', 'left']) {
  STYLES[`padding-${side}`] = [SIZE]; STYLES[`margin-${side}`] = [SIZE]; STYLES[`border-${side}`] = STYLES.border;
}
const TAGS = new Set('div span p br hr h1 h2 h3 h4 h5 h6 strong b em i u s small blockquote ul ol li a img table thead tbody tfoot tr td th caption colgroup col center'.split(' '));

function classToken(value) {
  if (typeof value !== 'string' || value === SCOPE_CLASS || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,79}$/.test(value)) return null;
  const next = value.startsWith(CLASS_PREFIX) ? value : CLASS_PREFIX + value;
  return next.length <= 85 ? next : null;
}

function declarations(nodes) {
  const result = [];
  for (const node of nodes || []) {
    if (node.type !== 'decl') continue;
    const prop = node.prop.toLowerCase(), value = node.value.trim();
    if (!Object.hasOwn(STYLES, prop) || !value || value.length > 512
      || /[\\{}<>@]|(?:url|expression|var|attr|env|image|element|paint)\s*\(/i.test(value)
      || !STYLES[prop].some(rule => rule.test(value))) continue;
    result.push({ prop, value, important: node.important === true });
  }
  return result;
}

function inlineDeclarations(value) {
  if (typeof value !== 'string' || value.length > MAX_CSS_BYTES) return [];
  try {
    const parsed = postcss.parse(`x{${value}}`, { from: undefined });
    if (parsed.nodes.length !== 1 || parsed.nodes[0].type !== 'rule' || parsed.nodes[0].selector !== 'x') return [];
    return declarations(parsed.nodes[0].nodes);
  } catch { return []; }
}
function declarationText(values) {
  return values.map(d => `${d.prop}:${d.value}${d.important ? ' !important' : ''}`).join(';');
}

function selector(value) {
  if (typeof value !== 'string' || value.length > 256 || !/^[a-zA-Z0-9_.* >-]+$/.test(value)) return null;
  let text = value.trim().replace(/\s*>\s*/g, ' > ').replace(/\s+/g, ' ');
  if (!text) return null;
  let pieces = text.split(' ');
  if (pieces[0] === SCOPE) pieces.shift();
  while (pieces[0] === 'html' || pieces[0] === 'body') pieces.shift();
  if (pieces[0] === '>') pieces.shift();
  if (!pieces.length) return SCOPE;
  if (pieces.length > 15 || pieces[pieces.length - 1] === '>') return null;
  const output = [];
  for (const piece of pieces) {
    if (piece === '>') {
      if (!output.length || output[output.length - 1] === '>') return null;
      output.push(piece); continue;
    }
    const match = /^(\*|[a-zA-Z][a-zA-Z0-9-]*)?((?:\.[a-zA-Z_][a-zA-Z0-9_-]{0,79})*)$/.exec(piece);
    if (!match || (!match[1] && !match[2])) return null;
    const tag = (match[1] || '').toLowerCase();
    if (tag && tag !== '*' && !TAGS.has(tag)) return null;
    const classes = (match[2].match(/\.[a-zA-Z_][a-zA-Z0-9_-]*/g) || []).map(x => classToken(x.slice(1)));
    if (classes.some(x => !x)) return null;
    output.push(tag + classes.map(x => '.' + x).join(''));
  }
  return `${SCOPE} ${output.join(' ')}`;
}

function mediaCondition(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const text = value.trim().toLowerCase().replace(/\s+/g, ' ');
  const groups = text.split(',').map(x => x.trim());
  if (!groups.length || groups.length > 4) return null;
  const validated = [];
  for (let group of groups) {
    group = group.replace(/^(?:only )?screen\s+and\s+/, '');
    const terms = group.split(/\s+and\s+/);
    if (!terms.length || terms.length > 2) return null;
    const output = [];
    for (const term of terms) {
      const match = /^\(\s*(min|max)-width\s*:\s*(\d{1,4}(?:\.\d{1,2})?)px\s*\)$/.exec(term);
      if (!match || Number(match[2]) < 1 || Number(match[2]) > 2560) return null;
      output.push(`(${match[1]}-width:${Number(match[2])}px)`);
    }
    validated.push(output.join(' and '));
  }
  return validated.join(',');
}

function stylesheets(sources) {
  const source = sources.join('\n');
  if (Buffer.byteLength(source) > MAX_CSS_BYTES) return { css: '', rules: [] };
  let root;
  try { root = postcss.parse(source, { from: undefined }); } catch { return { css: '', rules: [] }; }
  const rules = [], seen = new Set(); let selectors = 0, declarationCount = 0;
  function parseRules(nodes, media = null) {
    const output = [];
    for (const node of nodes || []) {
      if (node.type === 'atrule') {
        if (media !== null || node.name.toLowerCase() !== 'media' || !node.nodes) continue;
        const condition = mediaCondition(node.params);
        if (!condition) continue;
        const children = parseRules(node.nodes, condition);
        if (children.length) output.push(`@media ${condition}{${children.join('')}}`);
      } else if (node.type === 'rule') {
        if (rules.length >= 256) continue;
        const raw = node.selector.split(',');
        if (raw.length > 16 || selectors + raw.length > 512) continue;
        const selected = raw.map(selector);
        if (selected.some(x => !x)) continue;
        const values = declarations(node.nodes);
        if (!values.length || declarationCount + values.length > 4096) continue;
        const signature = `${media || ''}|${selected.join(',')}|${declarationText(values)}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        selectors += selected.length; declarationCount += values.length;
        rules.push({ selectors: selected, declarations: values, media });
        output.push(`${selected.join(',')}{${declarationText(values)}}`);
      }
    }
    return output;
  }
  return { css: parseRules(root.nodes).join(''), rules };
}

function element(node) { return Boolean(node && node.name && node.attribs); }
function matchesCompound(node, token) {
  if (!element(node)) return false;
  const match = /^(\*|[a-zA-Z][a-zA-Z0-9-]*)?((?:\.[a-zA-Z_][a-zA-Z0-9_-]*)*)$/.exec(token);
  if (!match || (match[1] && match[1] !== '*' && node.name !== match[1])) return false;
  const classes = new Set((node.attribs.class || '').split(/\s+/));
  return (match[2].match(/\.[a-zA-Z_][a-zA-Z0-9_-]*/g) || []).every(x => classes.has(x.slice(1)));
}
function matchesSelector(node, selected) {
  const pieces = selected.split(' '); let index = pieces.length - 1, current = node;
  if (!matchesCompound(current, pieces[index--])) return false;
  while (index >= 0) {
    if (pieces[index] === '>') {
      current = current.parent; index--;
      if (index < 0 || !matchesCompound(current, pieces[index--])) return false;
    } else {
      current = current.parent;
      while (current && !matchesCompound(current, pieces[index])) current = current.parent;
      if (!current) return false;
      index--;
    }
  }
  return true;
}

function hiddenDeclarations(values) {
  return values.some(({ prop, value }) =>
    (prop === 'display' && value === 'none')
    || (['font-size', 'line-height', 'width', 'height', 'max-width', 'max-height'].includes(prop) && /^0(?:\.0+)?(?:px|em|rem|%|pt)?$/.test(value))
    || (prop === 'font' && /(?:^|\s)0(?:px|pt|em|rem)(?:\/|\s)/.test(value))
    || (prop === 'font-size' && tinyFont(value))
    || (prop === 'font' && tinyFont((/(?:^|\s)(\d+(?:\.\d+)?(?:px|pt|em|rem))(?:\/|\s)/.exec(value) || [])[1]))
    || (prop === 'color' && (value.toLowerCase() === 'transparent' || /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(value))));
}

function tinyFont(value) {
  const match = /^(\d+(?:\.\d+)?)(px|pt|em|rem|%)$/.exec(value || '');
  if (!match) return false;
  const factor = { px: 1, pt: 4 / 3, em: 16, rem: 16, '%': 0.16 }[match[2]];
  return Number(match[1]) * factor < 8;
}

// Exact equal-colour checks cover common concealed links without claiming a
// contrast/accessibility engine. Transparent backgrounds retain their parent.
function opaqueColor(value) {
  const color = String(value).trim().toLowerCase();
  const named = { white: 'ffffff', black: '000000', red: 'ff0000', blue: '0000ff', green: '008000', gray: '808080', grey: '808080', yellow: 'ffff00' };
  if (named[color]) return named[color];
  const hex = /^#([a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/.exec(color);
  if (hex) {
    let digits = hex[1];
    if (digits.length < 5) digits = [...digits].map(x => x + x).join('');
    return digits.length === 6 || digits.slice(6) === 'ff' ? digits.slice(0, 6) : null;
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(1(?:\.0+)?))?\s*\)$/.exec(color);
  if (!rgb || rgb.slice(1, 4).some(x => Number(x) > 255)) return null;
  return rgb.slice(1, 4).map(x => Number(x).toString(16).padStart(2, '0')).join('');
}

module.exports = { SCOPE_CLASS, SCOPE, CLASS_PREFIX, MAX_CSS_BYTES, STYLES, classToken,
  declarations, inlineDeclarations, declarationText, selector, mediaCondition, stylesheets,
  matchesSelector, hiddenDeclarations, opaqueColor };
