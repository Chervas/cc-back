'use strict';

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function configuredClinicIds(configRecord) {
  const config = parseObject(configRecord?.config);
  const locations = Array.isArray(config.locations) ? config.locations : [];
  return Array.from(new Set(locations
    .map((location) => positiveInt(
      location?.id ?? location?.value ?? location?.clinic_id ?? location?.clinica_id,
    ))
    .filter(Boolean)));
}

function normalizeHttpUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    let pathname = decodeURIComponent(parsed.pathname || '/')
      .replace(/\/{2,}/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (!pathname) pathname = '/';
    return { hostname, pathname };
  } catch (_error) {
    return null;
  }
}

function pagePathMatchesClinic(pagePath, clinicPath) {
  if (!pagePath || !clinicPath) return false;
  if (clinicPath === '/') return pagePath === '/';
  return pagePath === clinicPath || pagePath.startsWith(`${clinicPath}/`);
}

function matchClinicByPageUrl(pageUrl, clinics, allowedClinicIds = []) {
  const page = normalizeHttpUrl(pageUrl);
  if (!page) return null;

  const allowed = new Set((Array.isArray(allowedClinicIds) ? allowedClinicIds : [])
    .map(positiveInt)
    .filter(Boolean));
  const candidates = [];

  for (const clinic of (Array.isArray(clinics) ? clinics : [])) {
    const clinicId = positiveInt(clinic?.id_clinica ?? clinic?.id);
    if (!clinicId || (allowed.size && !allowed.has(clinicId))) continue;
    if (![true, 1, '1'].includes(clinic?.estado_clinica)) continue;

    const clinicUrl = normalizeHttpUrl(clinic?.url_web);
    if (!clinicUrl || clinicUrl.hostname !== page.hostname) continue;
    if (!pagePathMatchesClinic(page.pathname, clinicUrl.pathname)) continue;

    candidates.push({ clinic, pathLength: clinicUrl.pathname.length });
  }

  if (!candidates.length) return null;
  candidates.sort((left, right) => right.pathLength - left.pathLength);
  if (candidates.length > 1 && candidates[0].pathLength === candidates[1].pathLength) {
    return null;
  }
  return candidates[0].clinic;
}

module.exports = {
  configuredClinicIds,
  matchClinicByPageUrl,
  normalizeHttpUrl,
  pagePathMatchesClinic,
};
