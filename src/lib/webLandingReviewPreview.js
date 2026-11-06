'use strict';

const crypto = require('node:crypto');

const PREVIEW_CSS = '.cc-preview-note,.cc-preview-interest{font:inherit!important;line-height:1.5!important;background:#f3f0ff!important;color:#312e81!important;padding:12px!important;border-radius:8px!important;margin:0 0 12px!important}.cc-preview-note a{color:inherit!important;text-decoration:underline!important}.cc-form input:disabled,.cc-form textarea:disabled,.cc-form select:disabled{opacity:1;-webkit-text-fill-color:currentColor}.cc-form button:disabled{opacity:1;cursor:default}';
const escapeAttribute = s => String(s).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

function readOnlyContactScript(contexts) {
  return `'use strict';\n(()=>{const contexts=${JSON.stringify(contexts)};const byId=new Map(contexts.map(x=>['cc-'+x.button_node_id,x]));document.addEventListener('click',event=>{const link=event.target.closest('a[id]');const context=link&&byId.get(link.id);if(!context)return;const form=document.getElementById('cc-'+context.form_node_id);if(!form)return;const summary=form.querySelector('.cc-preview-interest');if(summary){summary.hidden=false;summary.textContent='Te interesa: '+context.label;summary.dataset.interestValue=context.value;}const select=form.querySelector('select[name="interest"],select[data-preview-field="interest"]');if(select&&[...select.options].some(option=>option.value===context.value))select.value=context.value;});})();\n`;
}

/**
 * Compile a read-only review copy from a normal artifact, not hand-written page
 * HTML. The only executable code updates local UI state from the reviewed model.
 * It has no network, storage, submission or provider capability.
 */
function buildReadOnlyWebPreview({ artifact, baseUrl, overviewUrl, mediaUrl, contactContext = [] }) {
  const base = new URL(baseUrl), overview = new URL(overviewUrl);
  if (base.protocol !== 'https:' || overview.protocol !== 'https:' || base.origin !== overview.origin) throw Error('review_https_origin_required');
  const previousBase = artifact.manifest.base_url.replace(/\/$/, '') + '/';
  const nextBase = base.href.replace(/\/$/, '') + '/';
  const files = {};
  const script = readOnlyContactScript(contactContext);
  const scriptHash = crypto.createHash('sha256').update(script).digest('base64');
  const scriptName = `assets/review-contact.${crypto.createHash('sha256').update(script).digest('hex').slice(0, 16)}.js`;
  const cssName = `assets/review-notice.${crypto.createHash('sha256').update(PREVIEW_CSS).digest('hex').slice(0, 16)}.css`;
  const csp = `default-src 'none'; base-uri 'none'; form-action 'none'; img-src 'self' data:; style-src 'self'; script-src 'sha256-${scriptHash}'; connect-src 'none'; font-src 'self'; object-src 'none'; upgrade-insecure-requests`;
  for (const [name, content] of Object.entries(artifact.files)) {
    if (['robots.txt', 'sitemap.xml'].includes(name) || /\.(?:m?js)$/i.test(name)) continue;
    let value = typeof content === 'string'
      ? content.split(previousBase).join(nextBase).replace(/https:\/\/media\.clinicaclick\.com\/bs-preview\/(media_[a-f0-9]+)/g, (_, key) => mediaUrl(key))
      : content;
    if (/\.html?$/i.test(name)) {
      value = value
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<meta name="clinicaclick-artifact-input"[^>]*>/g, '')
        .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/g, `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`)
        .replace(/<meta name="robots"[^>]*>/g, '<meta name="robots" content="noindex,nofollow,noarchive">')
        .replace(/<form\b([^>]*)>/gi, (_, attrs) => '<div' + attrs.replace(/\s(?:action|method|enctype|accept-charset|data-cc-native-intake)="[^"]*"/gi, '') + ' role="group" aria-label="Formulario de demostración"><p class="cc-preview-note">Vista previa: el formulario está desactivado. <a href="' + escapeAttribute(overview.href) + '">Ver todas las landings</a></p><p class="cc-preview-interest" role="status" aria-live="polite" hidden></p>')
        .replace(/<\/form>/gi, '</div>')
        .replace(/<input\b[^>]*type="hidden"[^>]*>/gi, '')
        .replace(/<input\b[^>]*class="cc-honeypot"[^>]*>/gi, '')
        .replace(/<(input|textarea|select)\b([^>]*)>/gi, (_, tag, attrs) => {
          const field = attrs.match(/\sname="([^"]*)"/)?.[1];
          return '<' + tag + attrs.replace(/\s(?:name|required|autocomplete)(?:="[^"]*")?/gi, '') + (field === 'interest' ? ' data-preview-field="interest"' : '') + ' disabled>';
        })
        .replace(/<button\b([^>]*)>/gi, (_, attrs) => '<button' + attrs.replace(/\stype="[^"]*"/gi, '') + ' type="button" disabled title="Formulario desactivado en esta vista previa">')
        .replace('</head>', `<link rel="stylesheet" href="${escapeAttribute(nextBase + cssName)}"></head>`)
        .replace('</body>', `<script src="${escapeAttribute(nextBase + scriptName)}" integrity="sha256-${scriptHash}" defer></script></body>`);
      if (/<form\b|\son[a-z]+=|\/_clinicaclick\//i.test(value)) throw Error('review_operational_markup_rejected');
    }
    files[name] = value;
  }
  files[scriptName] = script;
  files[cssName] = PREVIEW_CSS;
  return { files, csp, contact_script: scriptName, submissions_enabled: false, network_enabled: false };
}

module.exports = { buildReadOnlyWebPreview, readOnlyContactScript };
