'use strict';

// Email HTML is untrusted, including catalog HTML. Keep the policy in one place
// so saving, draft previews and the final transport render use the same parser.
const sanitizeHtml = require('sanitize-html');
const { parseDocument, DomUtils } = require('htmlparser2');
const css = require('../lib/marketing-email-css');
const { MAX_REQUEST_BYTES } = require('../../services/integrations-broker/src/email-limits');
const MAX_SOURCE_BYTES = 96 * 1024;
const CONTENT_BUDGET_BYTES = MAX_REQUEST_BYTES - 16 * 1024;
const VARIABLE = /\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/g;
const EXACT_VARIABLE = /^\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}$/;
const STYLES = css.STYLES;
const NON_TEXT = ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'head', 'title'];

function invalid(code, message) {
  throw Object.assign(new Error(message), { code, status: 400 });
}

function httpsUrl(value, { allowVariables = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (allowVariables && EXACT_VARIABLE.test(raw)) return raw;
  try {
    const candidate = allowVariables ? raw.replace(VARIABLE, 'email-variable') : raw;
    if (/[\u0000-\u0020\u007f\\]/.test(candidate)) return null;
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null;
    if (!allowVariables && /\{\{|\}\}/.test(raw)) return null;
    return raw;
  } catch { return null; }
}

function telephoneUrl(value) {
  const raw = String(value || '').trim();
  return /^tel:\+?[0-9]{3,15}$/i.test(raw) ? raw.toLowerCase() : null;
}

const RESPONSIVE_CSS = 'table{max-width:100%}img{max-width:100%}'
  + '@media screen and (max-width:640px){'
  + '.cc-e-fluid{width:100% !important;max-width:100% !important;box-sizing:border-box !important}'
  + 'img{max-width:100%;height:auto !important}}';

function walk(root, visit) {
  const stack = [root]; let count = 0;
  while (stack.length) {
    const node = stack.pop();
    if (++count > 20000) invalid('email_template_html_too_large', 'El HTML contiene demasiados elementos.');
    visit(node);
    if (node.children) stack.push(...node.children);
  }
}

function authoredDocument(value) {
  const doc = parseDocument(value, { decodeEntities: true });
  const styles = []; let responsive = false;
  walk(doc, node => {
    if (node.name === 'style') {
      styles.push((node.children || []).filter(x => x.type === 'text').map(x => x.data).join(''));
      DomUtils.removeElement(node); return;
    }
    if (!node.attribs) return;
    if (['table', 'img'].includes(node.name)) responsive = true;
    const values = css.inlineDeclarations(node.attribs.style || '');
    const width = values.findLast(x => x.prop === 'width');
    const widthPx = width && /^(\d+(?:\.\d+)?)px$/.exec(width.value);
    const attrWidth = /^(\d+(?:\.\d+)?)$/.exec(node.attribs.width || '');
    const fixed = Number(widthPx?.[1] || attrWidth?.[1] || 0);
    const singleCell = ['td', 'th'].includes(node.name) && (node.parent?.children || [])
      .filter(child => ['td', 'th'].includes(child.name)).length === 1;
    const container = ['table', 'div', 'center', 'img'].includes(node.name) || singleCell;
    if (fixed >= 480 && fixed <= 2560 && container) {
      responsive = true;
      if (['table', 'td', 'th'].includes(node.name)) node.attribs.width = '100%';
      if (width) width.value = '100%'; else values.push({ prop: 'width', value: '100%', important: false });
      if (!values.some(x => x.prop === 'max-width')) values.push({ prop: 'max-width', value: `${fixed}px`, important: false });
      node.attribs.class = `${node.attribs.class || ''} cc-e-fluid`.trim();
    }
    if (node.attribs.style !== undefined || values.length) node.attribs.style = css.declarationText(values);
  });
  // Unwrap only our attribute-free compiled wrapper. Every call creates a new
  // author boundary, so an input marker never grants access to system chrome.
  function unwrap(parent) {
    if (!parent.children) return;
    const children = [];
    for (const child of parent.children) {
      unwrap(child);
      if (child.name === 'div' && child.attribs?.class === css.SCOPE_CLASS && Object.keys(child.attribs).length === 1) {
        for (const nested of child.children || []) { nested.parent = parent; children.push(nested); }
      } else children.push(child);
    }
    parent.children = children;
    for (let i = 0; i < children.length; i++) { children[i].prev = children[i - 1] || null; children[i].next = children[i + 1] || null; }
  }
  unwrap(doc);
  if (responsive) styles.push(RESPONSIVE_CSS);
  return { html: DomUtils.getOuterHTML(doc), css: css.stylesheets(styles).css };
}

function sanitizeEmailHtml(value, { allowVariables = false } = {}) {
  const raw = String(value || '');
  if (Buffer.byteLength(raw) > 1024 * 1024) invalid('email_template_content_too_large', 'El HTML completo supera el tamaño permitido.');
  const source = authoredDocument(raw);
  const clean = sanitizeHtml(source.html, {
    allowedTags: ['div', 'span', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'center'],
    allowedAttributes: {
      '*': ['class', 'style', 'title', 'lang', 'dir', 'align'],
      a: ['href', 'target', 'rel'], img: ['src', 'alt', 'width', 'height'],
      table: ['role', 'width', 'height', 'cellpadding', 'cellspacing', 'border', 'bgcolor'],
      td: ['width', 'height', 'colspan', 'rowspan', 'valign', 'bgcolor'],
      th: ['width', 'height', 'colspan', 'rowspan', 'valign', 'scope', 'bgcolor'],
      tr: ['valign', 'bgcolor'], col: ['width', 'span'], colgroup: ['width', 'span'],
    },
    allowedStyles: { '*': STYLES },
    allowedSchemes: ['https'], allowProtocolRelative: false,
    // The custom URL gate supports source placeholders and validates the fully
    // substituted URL again at final render. No CSS URL-bearing properties exist.
    allowedSchemesAppliedToAttributes: [],
    nonTextTags: NON_TEXT, nestingLimit: 60,
    transformTags: {
      body: (tagName, attribs) => ({ tagName: 'div', attribs }),
      '*': (tagName, attribs) => {
        const next = { ...attribs };
        if (next.class !== undefined) {
          const classes = [...new Set(next.class.split(/\s+/).slice(0, 32).map(css.classToken).filter(Boolean))];
          if (classes.length) next.class = classes.join(' '); else delete next.class;
        }
        for (const key of Object.keys(next)) {
          if (key !== 'style' && key !== 'href' && key !== 'src'
            && !['alt', 'title'].includes(key) && /\{\{|\}\}/.test(next[key])) delete next[key];
        }
        if (next.href !== undefined) {
          const telephone = telephoneUrl(next.href);
          const url = telephone || httpsUrl(next.href, { allowVariables });
          if (url) {
            next.href = url;
            next.rel = 'noopener noreferrer';
            if (telephone) delete next.target;
            else next.target = '_blank';
          } else delete next.href;
        }
        if (next.src !== undefined) {
          const url = httpsUrl(next.src, { allowVariables });
          if (url) next.src = url; else delete next.src;
        }
        return { tagName, attribs: next };
      },
    },
    // User-authored hidden content cannot impersonate our preheader/footer.
    // This also removes preheaders from older persisted block renderings.
    exclusiveFilter: frame => /(?:^|;)\s*display\s*:\s*none(?:\s*!important)?\s*(?:;|$)/i.test(frame.attribs.style || '')
      || (frame.tag === 'img' && !frame.attribs.src),
  });
  if (!clean.trim()) return '';
  // Styles are generated from the bounded AST allowlist, never raw <style>.
  // The wrapper closes before the compositor adds mandatory service links.
  return `<div class="${css.SCOPE_CLASS}">${source.css ? `<style>${source.css}</style>` : ''}${clean}</div>`;
}

function hasVisibleSystemLink(value, url) {
  if (!httpsUrl(url)) return false;
  const raw = String(value || '');
  if (Buffer.byteLength(raw) > 1024 * 1024) return false;
  try {
    const doc = parseDocument(raw, { decodeEntities: true });
    const styles = [], anchors = [];
    walk(doc, node => {
      if (node.name === 'style') styles.push((node.children || []).filter(x => x.type === 'text').map(x => x.data).join(''));
      if (node.name === 'a' && node.attribs?.href === url) anchors.push(node);
    });
    const { rules } = css.stylesheets(styles);
    return anchors.some(anchor => {
      const labels = [];
      walk(anchor, node => {
        if (node.type === 'text' && node.data.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, '')) labels.push(node);
      });
      return labels.some(label => {
      const path = [];
      for (let node = label.parent; node && node.type !== 'root'; node = node.parent) path.unshift(node);
      let colors = new Set(['000000']), backgrounds = new Set(['ffffff']);
      for (const node of path) {
        if (!node.attribs) continue;
        const declarations = rules.filter(rule => rule.selectors.some(selected => css.matchesSelector(node, selected)))
          .flatMap(rule => rule.declarations).concat(css.inlineDeclarations(node.attribs.style || ''));
        if (Object.hasOwn(node.attribs, 'hidden') || node.attribs['aria-hidden'] === 'true'
          || css.hiddenDeclarations(declarations)) return false;
        // Any width-media state that can hide the authored link requires the
        // protected footer. This intentionally errs towards adding that footer.
        const foreground = declarations.filter(d => d.prop === 'color').map(d => css.opaqueColor(d.value)).filter(Boolean);
        const background = declarations.filter(d => ['background', 'background-color'].includes(d.prop))
          .map(d => css.opaqueColor(d.value)).filter(Boolean);
        const legacyBackground = css.opaqueColor(node.attribs.bgcolor || '');
        if (foreground.length) colors = new Set(foreground);
        if (legacyBackground) background.push(legacyBackground);
        if (background.length) backgrounds = new Set(background);
        if (node === label.parent && [...colors].some(color => backgrounds.has(color))) return false;
      }
      return true;
      });
    });
  } catch { return false; }
}

function textFromHtml(value) {
  const parts = [];
  const links = [];
  const breaks = new Set(['p', 'div', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'li', 'tr', 'table', 'blockquote']);
  sanitizeHtml(String(value || ''), {
    allowedTags: [], allowedAttributes: {}, nonTextTags: NON_TEXT,
    textFilter(text) {
      parts.push(text.replace(/&(amp|lt|gt|quot);/g, (_match, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"' }[key])));
      return text;
    },
    onOpenTag(tag, attributes) {
      if (breaks.has(tag)) parts.push('\n');
      if (tag === 'img' && attributes.alt) parts.push(attributes.alt);
      if (tag === 'a') links.push(telephoneUrl(attributes.href) || httpsUrl(attributes.href, { allowVariables: true }));
    },
    onCloseTag(tag) {
      if (tag === 'a') { const url = links.pop(); if (url) parts.push(` (${url})`); }
      if (breaks.has(tag)) parts.push('\n');
    },
  });
  return parts.join('').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function validateHtmlSourceCode(value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) invalid('email_template_html_required', 'Añade el código HTML de la plantilla.');
  if (Buffer.byteLength(value, 'utf8') > MAX_SOURCE_BYTES) invalid('email_template_html_too_large', 'El HTML de la plantilla no puede superar 96 KiB.');
  // Source is code-editor data, never renderable markup. Preserve its exact
  // bytes (including comments and Unicode) across mode switches and saves.
  return value;
}

function compileHtmlSource(value, { allowEmpty = false } = {}) {
  const code = validateHtmlSourceCode(value, { allowEmpty });
  let source;
  try { source = sanitizeEmailHtml(code, { allowVariables: true }); }
  catch { invalid('email_template_html_invalid', 'No se pudo interpretar el HTML de la plantilla.'); }
  if (!allowEmpty && !source.trim()) invalid('email_template_html_required', 'El HTML no contiene contenido de email permitido.');
  return source;
}

function assertContentBudget(content) {
  // Reserve transport headers/envelope/signature overhead within the 256 KiB
  // broker request, and count JSON escaping plus both MIME alternatives.
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > CONTENT_BUDGET_BYTES) {
    invalid('email_template_content_too_large', 'El email completo supera el tamaño permitido. Reduce el HTML o el texto.');
  }
}

module.exports = { sanitizeEmailHtml, validateHtmlSourceCode, compileHtmlSource, textFromHtml, httpsUrl, telephoneUrl, hasVisibleSystemLink, assertContentBudget, MAX_SOURCE_BYTES };
