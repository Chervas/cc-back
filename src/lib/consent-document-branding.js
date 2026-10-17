'use strict';

// Branding is resolved once while a NEW document is issued. Read paths must
// consume this frozen DTO, not current mutable clinic/configuration records.
const net = require('node:net');
const { controller, object } = require('./registration-privacy-configuration');
const SCHEMA = 'cc-document-branding/v1';
const SOURCE_DOCUMENT_SHA256 = 'e31760491bf0929ca25a4976f4f2c463cece9af7a41ecb6c0e84508aaddb741f';
// Exact standalone logo images from the user-supplied FORMULARIO LOPD
// PACIENTES.docx, word/header1.xml. Not a rasterized document/page. The medical
// mark is white in the source, explicitly placed on a black rectangle.
const SOURCE_LOGOS = Object.freeze([
  Object.freeze({ clinic_id: 72, alt: 'BS Medical', background: 'dark',
    source_image_sha256: 'ed3860bbd39987e896b08e2228c73a542c3aed96863eb07549e440281b558d2d',
    url: 'data:image/png;base64,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' }),
  Object.freeze({ clinic_id: 66, alt: 'BS Capilar', background: 'light',
    source_image_sha256: '96e805cb21b678518448d9418ad9507a0ceab0b6f000f51bd0b53dae61241ee4',
    url: 'data:image/png;base64,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' }),
]);
const clean = (value, limit = 2000) => typeof value === 'string' || typeof value === 'number'
  ? String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
const escape = value => String(value).replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const fail = () => Object.assign(new Error('consent_document_branding_invalid'), {
  code: 'consent_document_branding_invalid', statusCode: 400,
});
function validateDocumentBrandingConfig(value) {
  if (value == null) return { schema_version: SCHEMA, show_logo: true, show_footer: true };
  const source = object(value);
  if (!source || Object.keys(source).some(key => !['schema_version', 'show_logo', 'show_footer'].includes(key))
    || source.schema_version !== SCHEMA || typeof source.show_logo !== 'boolean' || typeof source.show_footer !== 'boolean') throw fail();
  return { schema_version: SCHEMA, show_logo: source.show_logo, show_footer: source.show_footer };
}
function isPublicHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || !host.includes('.') || host === 'localhost' || /\.(?:localhost|local|internal|test|invalid|example)$/.test(host)) return false;
  const ip = net.isIP(host.replace(/^\[|\]$/g, ''));
  if (!ip) return !host.includes(':');
  if (ip === 6) return false;
  const octets = host.split('.').map(Number);
  return octets[0] !== 0 && octets[0] !== 10 && octets[0] !== 127 && octets[0] < 224
    && !(octets[0] === 169 && octets[1] === 254)
    && !(octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    && !(octets[0] === 192 && octets[1] === 168)
    && !(octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}
function safeLogoUrl(value, baseUrl = null) {
  const raw = clean(value, 4096);
  if (SOURCE_LOGOS.some(logo => logo.url === raw)) return raw;
  if (!raw || /[\\\s]/.test(raw) || raw.startsWith('//') || !/^https:\/\//i.test(raw) && !raw.startsWith('/')) return null;
  try {
    const url = new URL(raw, baseUrl || undefined);
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
      || !isPublicHost(url.hostname) || url.hash) return null;
    return url.toString();
  } catch (_) { return null; }
}
const publicLogo = logo => ({ url: logo.url, alt: logo.alt, background: logo.background });
// Tablet identity is live UI configuration, NOT evidence embedded in a signed
// document. Never use it to rebuild or replace document_branding snapshots.
function normalizeTabletBrandingConfig(value) {
  const source = object(value);
  return { source: source.source === 'group' ? 'group' : 'clinic',
    logo_url: typeof source.logo_url === 'string' && source.logo_url.trim() ? source.logo_url.trim() : null,
    logo_background: source.logo_background === 'dark' ? 'dark' : 'light' };
}
function validateTabletBrandingConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['source', 'logo_url', 'logo_background'].includes(key))
    || !['clinic', 'group'].includes(value.source) || !['light', 'dark'].includes(value.logo_background)
    || value.logo_url !== null && (typeof value.logo_url !== 'string' || !safeLogoUrl(value.logo_url))) {
    throw Object.assign(new Error('tablet_branding_invalid'), { code: 'tablet_branding_invalid', statusCode: 400 });
  }
  return normalizeTabletBrandingConfig(value);
}
function resolveTabletBranding(clinic, group = null, options = {}) {
  const configured = normalizeTabletBrandingConfig(object(object(clinic?.configuracion).patient_intake).tablet_branding);
  const groupId = Number(clinic?.grupoClinicaId || clinic?.grupo_clinica_id);
  const shared = configured.source === 'group' && Number.isSafeInteger(groupId) && groupId > 0
    && Number(group?.id_grupo) === groupId;
  const displayName = clean(shared ? group.nombre_grupo : clinic?.nombre_clinica || clinic?.nombre, 255);
  const override = (configured.source !== 'group' || shared) && safeLogoUrl(configured.logo_url, options.baseUrl);
  const clinicLogo = !shared && safeLogoUrl(clinic?.url_avatar, options.baseUrl);
  const original = !shared && SOURCE_LOGOS.find(logo => logo.clinic_id === Number(clinic?.id_clinica || clinic?.id));
  return { display_name: displayName || 'Clínica', source: shared ? 'group' : 'clinic',
    logo_url: override || clinicLogo || original?.url || null,
    logo_background: override || clinicLogo ? configured.logo_background : original ? original.background : 'light' };
}
function buildDocumentBranding(clinic, options = {}) {
  const configuration = validateDocumentBrandingConfig(options.configuration);
  const clinicId = Number(clinic?.id_clinica || clinic?.id);
  const clinicName = clean(clinic?.nombre_clinica || clinic?.nombre, 255);
  const responsible = controller(clinic);
  let logos = [];
  if (configuration.show_logo) {
    // The supplied common LOPD explicitly contains BOTH BS marks. Elsewhere
    // the room/clinic's own branding remains individual.
    if (options.purpose === 'data_protection' && [66, 72].includes(clinicId)) {
      logos = SOURCE_LOGOS.map(publicLogo);
    } else {
      const configuredUrl = safeLogoUrl(options.logoUrl || clinic?.url_avatar, options.baseUrl);
      const source = SOURCE_LOGOS.find(logo => logo.clinic_id === clinicId);
      logos = configuredUrl ? [{ url: configuredUrl, alt: clinicName || 'Clínica', background: 'light' }]
        : source ? [publicLogo(source)] : [];
    }
  }
  let footerLines = [];
  if (configuration.show_footer) {
    const legal = [clean(responsible.legal_name, 255), responsible.tax_id ? 'CIF / NIF: ' + clean(responsible.tax_id, 64) : ''].filter(Boolean).join(' · ');
    const address = clean(responsible.address);
    const contacts = [clean(responsible.phone, 64), clean(responsible.email, 255)].filter(Boolean).join(' · ');
    const dpo = clean(responsible.dpo_email, 255);
    const website = clean(clinic?.url_web, 512);
    footerLines = [legal, address, contacts, dpo ? 'DPO: ' + dpo : '', website].filter(Boolean);
  }
  return { schema_version: SCHEMA, clinic_name: clinicName, logos, footer_lines: footerLines };
}
function normalizeDocumentBranding(value) {
  const source = object(value);
  if (source.schema_version !== SCHEMA || typeof source.clinic_name !== 'string'
    || !Array.isArray(source.logos) || source.logos.length > 2 || !Array.isArray(source.footer_lines)
    || source.footer_lines.length > 8 || source.footer_lines.some(line => typeof line !== 'string')) return null;
  const logos = source.logos.map(logo => {
    if (!logo || typeof logo !== 'object' || typeof logo.alt !== 'string'
      || !['light', 'dark'].includes(logo.background)) return null;
    const url = safeLogoUrl(logo.url);
    return url ? { url, alt: clean(logo.alt, 255), background: logo.background } : null;
  });
  if (logos.some(logo => !logo)) return null;
  return { schema_version: SCHEMA, clinic_name: clean(source.clinic_name, 255), logos,
    footer_lines: source.footer_lines.map(line => clean(line)).filter(Boolean) };
}
function brandingFromSnapshot(document) {
  const plain = document?.toJSON ? document.toJSON() : document;
  return normalizeDocumentBranding(object(plain?.snapshot_json).document_branding);
}
function renderDocumentBrandingHtml(value, position = 'header') {
  const branding = normalizeDocumentBranding(value);
  if (!branding) return '';
  if (position === 'footer') return branding.footer_lines.length
    ? '<div class="consent-clinic-footer" data-document-branding="footer">'
      + branding.footer_lines.map(line => '<div>' + escape(line) + '</div>').join('') + '</div>' : '';
  if (position !== 'header') return '';
  return '<div class="consent-clinic-header" data-document-branding="header"><div class="consent-clinic-name">'
    + escape(branding.clinic_name) + '</div><div class="consent-clinic-logos">'
    + branding.logos.map(logo => '<span class="consent-clinic-logo-frame' + (logo.background === 'dark' ? ' on-dark' : '')
      + '"><img src="' + escape(logo.url) + '" alt="' + escape(logo.alt) + '" /></span>').join('') + '</div></div>';
}
module.exports = { SCHEMA, SOURCE_DOCUMENT_SHA256, SOURCE_LOGOS, validateDocumentBrandingConfig,
  safeLogoUrl, buildDocumentBranding, normalizeDocumentBranding, brandingFromSnapshot, renderDocumentBrandingHtml,
  normalizeTabletBrandingConfig, validateTabletBrandingConfig, resolveTabletBranding };

