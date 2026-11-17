'use strict';

// Email HTML is untrusted, including catalog HTML. Keep the policy in one place
// so saving, draft previews and the final transport render use the same parser.
const sanitizeHtml = require('sanitize-html');
const { MAX_REQUEST_BYTES } = require('../../services/integrations-broker/src/email-limits');
const MAX_SOURCE_BYTES = 96 * 1024;
const CONTENT_BUDGET_BYTES = MAX_REQUEST_BYTES - 16 * 1024;
const VARIABLE = /\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/g;
const EXACT_VARIABLE = /^\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}$/;
const COLOR = /^(?:#[a-f\d]{3,8}|[a-z]+|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/i;
const SIZE = /^(?:0|\d+(?:\.\d+)?(?:px|em|rem|%|pt)|auto)$/;
const SIZES = /^(?:0|\d+(?:\.\d+)?(?:px|em|rem|%|pt)|auto)(?:\s+(?:0|\d+(?:\.\d+)?(?:px|em|rem|%|pt)|auto)){0,3}$/;
const STYLES = {
  color: [COLOR], 'background-color': [COLOR], background: [COLOR],
  width: [SIZE], height: [SIZE], 'max-width': [SIZE], 'min-width': [SIZE], 'max-height': [SIZE],
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
};
for (const side of ['top', 'right', 'bottom', 'left']) {
  STYLES[`padding-${side}`] = [SIZE];
  STYLES[`margin-${side}`] = [SIZE];
  STYLES[`border-${side}`] = STYLES.border;
}
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

function sanitizeEmailHtml(value, { allowVariables = false } = {}) {
  return sanitizeHtml(String(value || ''), {
    allowedTags: ['div', 'span', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'center'],
    allowedAttributes: {
      '*': ['style', 'title', 'lang', 'dir', 'align'],
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
        for (const key of Object.keys(next)) {
          if (key !== 'style' && key !== 'href' && key !== 'src'
            && !['alt', 'title'].includes(key) && /\{\{|\}\}/.test(next[key])) delete next[key];
        }
        if (next.href !== undefined) {
          const url = httpsUrl(next.href, { allowVariables });
          if (url) { next.href = url; next.rel = 'noopener noreferrer'; next.target = '_blank'; }
          else delete next.href;
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
      if (tag === 'a') links.push(httpsUrl(attributes.href, { allowVariables: true }));
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

module.exports = { sanitizeEmailHtml, validateHtmlSourceCode, compileHtmlSource, textFromHtml, httpsUrl, assertContentBudget, MAX_SOURCE_BYTES };
