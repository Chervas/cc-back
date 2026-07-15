'use strict';

const db = require('../../models');

const Clinica = db.Clinica;
const ClinicBusinessLocation = db.ClinicBusinessLocation;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asPlainObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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

async function loadClinic(clinicOrId) {
  if (typeof clinicOrId === 'object' && clinicOrId !== null) return clinicOrId;
  const clinicId = Number(clinicOrId || 0);
  if (!clinicId || !Clinica) return {};
  return Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'nombre_clinica', 'direccion', 'url_ficha_local', 'configuracion'],
    raw: true,
  }) || {};
}

function firstPositiveInteger(...values) {
  for (const value of values) {
    const parsed = Number(value || 0);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function firstString(...values) {
  for (const value of values) {
    const parsed = cleanString(value);
    if (parsed) return parsed;
  }
  return '';
}

function getReviewProfileAliasConfig(clinic) {
  const config = asPlainObject(clinic?.configuracion);
  const reviews = asPlainObject(config.reviews || config.resenas || config.review_requests);
  const alias = asPlainObject(reviews.google_business_profile_alias || reviews.business_profile_alias);
  const clinicId = firstPositiveInteger(
    alias.clinic_id,
    alias.clinica_id,
    alias.clinicId,
    reviews.google_business_profile_alias_clinic_id,
    reviews.google_business_location_alias_clinic_id,
    reviews.review_google_profile_alias_clinic_id,
    config.review_google_business_profile_alias_clinic_id,
    config.review_google_profile_alias_clinic_id,
    config.review_google_alias_clinic_id
  );
  const businessLocationId = firstPositiveInteger(
    alias.business_location_id,
    alias.businessLocationId,
    reviews.google_business_profile_alias_business_location_id,
    reviews.google_business_location_alias_business_location_id,
    config.review_google_business_profile_alias_business_location_id
  );
  const locationId = firstString(
    alias.location_id,
    alias.locationId,
    reviews.google_business_profile_alias_location_id,
    reviews.google_business_location_alias_location_id,
    config.review_google_business_profile_alias_location_id
  );

  if (!clinicId && !businessLocationId && !locationId) return null;
  return { clinicId, businessLocationId, locationId };
}

async function findReviewAliasLocation(clinic) {
  const alias = getReviewProfileAliasConfig(clinic);
  if (!alias || !ClinicBusinessLocation) return null;

  let location = null;
  if (alias.businessLocationId) {
    location = await ClinicBusinessLocation.findOne({
      where: { id: alias.businessLocationId, is_active: true },
      raw: true,
    });
  }
  if (!location && alias.locationId) {
    location = await ClinicBusinessLocation.findOne({
      where: { location_id: alias.locationId, is_active: true },
      order: [['last_synced_at', 'DESC'], ['updated_at', 'DESC']],
      raw: true,
    });
  }
  if (!location && alias.clinicId) {
    location = await findActiveBusinessLocation(alias.clinicId);
  }
  if (!location) return null;

  const aliasClinicId = Number(location.clinica_id || alias.clinicId || 0);
  const aliasClinic = aliasClinicId && Clinica
    ? await Clinica.findByPk(aliasClinicId, {
      attributes: ['id_clinica', 'nombre_clinica', 'direccion', 'url_ficha_local', 'configuracion'],
      raw: true,
    })
    : null;

  return { alias, location, clinic: aliasClinic || {} };
}

async function resolveClinicGoogleReviewProfile(clinicOrId) {
  const clinic = await loadClinic(clinicOrId);
  const clinicId = Number(clinic?.id_clinica || clinic?.clinica_id || clinic?.id || 0);
  const baseLinks = await resolveClinicGoogleLocalLinks(clinicId ? clinic : clinicOrId);
  const aliasLocation = await findReviewAliasLocation(clinic);
  if (!aliasLocation?.location) {
    return {
      clinic,
      location: null,
      locationClinic: null,
      alias: false,
      links: baseLinks,
    };
  }

  const aliasLinks = buildLinksFromBusinessLocation(aliasLocation.location, aliasLocation.clinic || clinic);
  return {
    clinic,
    location: aliasLocation.location,
    locationClinic: aliasLocation.clinic || {},
    alias: true,
    links: {
      ...baseLinks,
      url_dejar_resena: cleanString(aliasLinks.url_dejar_resena) || cleanString(baseLinks.url_dejar_resena),
      review_profile_alias: true,
      review_profile_alias_clinic_id: Number(aliasLocation.location.clinica_id || 0) || null,
      review_profile_alias_business_location_id: Number(aliasLocation.location.id || 0) || null,
      review_profile_alias_location_id: cleanString(aliasLocation.location.location_id),
      review_profile_alias_location_name: cleanString(aliasLocation.location.location_name),
    },
  };
}

async function resolveClinicGoogleReviewLinks(clinicOrId) {
  const profile = await resolveClinicGoogleReviewProfile(clinicOrId);
  return profile.links;
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
  resolveClinicGoogleReviewLinks,
  resolveClinicGoogleReviewProfile,
};
