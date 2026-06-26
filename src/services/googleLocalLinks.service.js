'use strict';

const db = require('../../models');

const Clinica = db.Clinica;
const ClinicBusinessLocation = db.ClinicBusinessLocation;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePlaceId(value) {
  const raw = cleanString(value);
  if (!raw) return '';
  return raw.replace(/^places\//, '');
}

function encode(value) {
  return encodeURIComponent(cleanString(value));
}

function buildGoogleMapsProfileUrl({ placeId, query } = {}) {
  const id = normalizePlaceId(placeId);
  if (!id) return '';
  const text = cleanString(query) || id;
  return `https://www.google.com/maps/search/?api=1&query=${encode(text)}&query_place_id=${encode(id)}`;
}

function buildGoogleMapsDirectionsUrl({ placeId, query } = {}) {
  const id = normalizePlaceId(placeId);
  const text = cleanString(query);
  if (id) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encode(text || id)}&destination_place_id=${encode(id)}`;
  }
  if (text) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encode(text)}`;
  }
  return '';
}

function extractRawPayload(location) {
  const raw = location?.raw_payload || location?.rawPayload || {};
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function buildQueryLabel(location, clinic = {}) {
  return cleanString(location?.location_name)
    || cleanString(location?.name)
    || cleanString(clinic?.nombre_clinica)
    || cleanString(clinic?.nombre)
    || cleanString(clinic?.direccion)
    || '';
}

function buildClinicDirectionsQuery(clinic = {}) {
  return [
    cleanString(clinic?.nombre_clinica) || cleanString(clinic?.nombre),
    cleanString(clinic?.direccion),
  ].filter(Boolean).join(', ');
}

function buildLinksFromBusinessLocation(location, clinic = {}) {
  const raw = extractRawPayload(location);
  const placeId = normalizePlaceId(raw?.metadata?.placeId)
    || normalizePlaceId(raw?.placeId)
    || normalizePlaceId(raw?.locationKey?.placeId)
    || '';
  const query = buildQueryLabel(location, clinic);
  const mapsUri = cleanString(raw?.metadata?.mapsUri) || cleanString(location?.mapsUri);
  const newReviewUri = cleanString(raw?.metadata?.newReviewUri) || cleanString(location?.newReviewUri);
  const generatedProfileUrl = buildGoogleMapsProfileUrl({ placeId, query });
  const profileUrl = mapsUri || generatedProfileUrl;
  const directionsUrl = buildGoogleMapsDirectionsUrl({ placeId, query })
    || profileUrl;

  return {
    source: profileUrl ? 'google_business_profile' : null,
    business_location_id: location?.id || null,
    location_id: cleanString(location?.location_id || location?.locationId),
    location_name: cleanString(location?.location_name || location?.name),
    place_id: placeId || null,
    url_perfil_google: profileUrl,
    url_como_llegar: directionsUrl,
    url_dejar_resena: newReviewUri,
  };
}

async function findActiveBusinessLocation(clinicId) {
  const safeClinicId = Number(clinicId || 0);
  if (!safeClinicId || !ClinicBusinessLocation) return null;
  return ClinicBusinessLocation.findOne({
    where: { clinica_id: safeClinicId, is_active: true },
    order: [['last_synced_at', 'DESC'], ['updated_at', 'DESC']],
    raw: true,
  });
}

async function resolveClinicGoogleLocalLinks(clinicOrId) {
  let clinic = typeof clinicOrId === 'object' && clinicOrId !== null ? clinicOrId : {};
  const clinicId = Number(
    typeof clinicOrId === 'object' && clinicOrId !== null
      ? (clinicOrId.id_clinica || clinicOrId.clinica_id || clinicOrId.id)
      : clinicOrId
  );
  if ((!clinic || !Object.keys(clinic).length) && clinicId && Clinica) {
    clinic = await Clinica.findByPk(clinicId, {
      attributes: ['id_clinica', 'nombre_clinica', 'direccion', 'url_ficha_local'],
      raw: true,
    }) || {};
  }
  const manualUrl = cleanString(clinic?.url_ficha_local);
  const location = await findActiveBusinessLocation(clinicId);
  const googleLinks = location ? buildLinksFromBusinessLocation(location, clinic) : null;
  const manualDirectionsUrl = buildGoogleMapsDirectionsUrl({ query: buildClinicDirectionsQuery(clinic) });
  const profileUrl = cleanString(googleLinks?.url_perfil_google) || manualUrl;
  const directionsUrl = cleanString(googleLinks?.url_como_llegar) || manualDirectionsUrl || profileUrl || manualUrl;

  return {
    source: googleLinks?.source || (manualDirectionsUrl ? 'manual_google_maps_directions' : (manualUrl ? 'manual_url_ficha_local' : null)),
    business_location_id: googleLinks?.business_location_id || null,
    location_id: googleLinks?.location_id || null,
    location_name: googleLinks?.location_name || null,
    place_id: googleLinks?.place_id || null,
    url_ficha_local: profileUrl,
    url_perfil_google: profileUrl,
    url_como_llegar: directionsUrl,
    url_dejar_resena: cleanString(googleLinks?.url_dejar_resena),
    url_ficha_local_manual: manualUrl,
    has_google_business_profile: !!googleLinks?.url_perfil_google,
  };
}

function mergeClinicLinksIntoContext(clinicPatch, links) {
  const base = clinicPatch && typeof clinicPatch === 'object' ? clinicPatch : {};
  const safeLinks = links && typeof links === 'object' ? links : {};
  const effectiveDirectionsUrl =
    cleanString(safeLinks.url_como_llegar)
    || cleanString(safeLinks.url_perfil_google)
    || cleanString(base.url_ficha_local);
  const effectiveAddress =
    cleanString(base.direccion)
    || cleanString(safeLinks.location_name)
    || effectiveDirectionsUrl;
  return {
    ...base,
    direccion: effectiveAddress,
    url_ficha_local_manual: cleanString(safeLinks.url_ficha_local_manual) || cleanString(base.url_ficha_local),
    url_ficha_local: cleanString(safeLinks.url_ficha_local) || cleanString(base.url_ficha_local),
    url_perfil_google: cleanString(safeLinks.url_perfil_google) || cleanString(safeLinks.url_ficha_local) || cleanString(base.url_ficha_local),
    url_como_llegar: effectiveDirectionsUrl,
    url_dejar_resena: cleanString(safeLinks.url_dejar_resena),
    perfil_google_conectado: safeLinks.has_google_business_profile === true,
    perfil_google_source: cleanString(safeLinks.source),
    perfil_google_place_id: cleanString(safeLinks.place_id),
    perfil_google_location_id: cleanString(safeLinks.location_id),
    perfil_google_location_name: cleanString(safeLinks.location_name),
  };
}

module.exports = {
  buildGoogleMapsDirectionsUrl,
  buildGoogleMapsProfileUrl,
  mergeClinicLinksIntoContext,
  resolveClinicGoogleLocalLinks,
};
