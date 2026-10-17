'use strict';

const branding = require('../lib/consent-document-branding');
const { object } = require('../lib/registration-privacy-configuration');
const plain = row => row?.toJSON ? row.toJSON() : row;

// Use precisely the clinic avatar resolution used by /clinicas, including its
// already-synchronized Google profile fallback. It reads local inventory only.
// Never persist that fallback into clinic settings or signed document evidence.
async function effectiveClinicAvatar(clinicRow, { resolveAvatar, baseUrl } = {}) {
  const clinic = plain(clinicRow) || {};
  let avatar = null;
  try {
    const resolve = resolveAvatar || require('./clinicBranding.service').resolveClinicAvatar;
    avatar = await resolve(clinic);
  } catch (_) { /* Missing branding must not prevent reading or signing. */ }
  return { ...clinic, url_avatar: branding.safeLogoUrl(avatar?.url,
    baseUrl || process.env.FRONTEND_PUBLIC_URL || 'https://crm.clinicaclick.com') };
}

async function resolveTabletBrandingForClinic(clinicRow, group = null, options = {}) {
  const clinic = plain(clinicRow) || {};
  const configured = branding.normalizeTabletBrandingConfig(object(object(clinic.configuracion).patient_intake).tablet_branding);
  // A separately chosen tablet identity takes precedence. A group without a
  // logo must not accidentally borrow a member clinic's Google/avatar identity.
  const resolved = branding.resolveTabletBranding(clinic, plain(group), options);
  if (resolved.source === 'group' || configured.source === 'clinic' && branding.safeLogoUrl(configured.logo_url, options.baseUrl)) {
    return resolved;
  }
  return branding.resolveTabletBranding(await effectiveClinicAvatar(clinic, options), plain(group), options);
}

module.exports = { effectiveClinicAvatar, resolveTabletBrandingForClinic };
