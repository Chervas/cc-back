'use strict';

function mappingInputError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  error.httpStatus = 400;
  return error;
}

function mappingAccessError(code, message, httpStatus = 403) {
  const error = new Error(message || code);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

function positiveClinicId(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeBusinessProfileLocationMappings(rawMappings) {
  if (!Array.isArray(rawMappings) || rawMappings.length === 0) {
    throw mappingInputError('business_profile_mappings_required', 'Debes seleccionar al menos una ubicación.');
  }

  const destinationByLocation = new Map();
  const normalizedByLocation = new Map();

  rawMappings.forEach((mapping, index) => {
    const clinicaId = positiveClinicId(mapping?.clinicaId);
    const locationId = String(mapping?.locationId || mapping?.id || '').trim();
    if (!clinicaId || !locationId) {
      throw mappingInputError(
        'business_profile_mapping_invalid',
        `El mapeo de la posición ${index + 1} no contiene una clínica y una ubicación válidas.`
      );
    }

    const previousDestination = destinationByLocation.get(locationId);
    if (previousDestination && previousDestination !== clinicaId) {
      throw mappingInputError(
        'business_profile_location_destination_conflict',
        'Una misma ubicación de Google no puede asignarse a clínicas distintas en la misma operación.'
      );
    }

    destinationByLocation.set(locationId, clinicaId);
    // Repetir exactamente el mismo destino es inocuo. Conservamos la última
    // versión para respetar los metadatos más recientes enviados por la UI.
    normalizedByLocation.set(locationId, {
      ...mapping,
      clinicaId,
      locationId,
    });
  });

  return Array.from(normalizedByLocation.values());
}

function movedOriginClinicIds(existingRecords, mappings) {
  const destinationByLocation = new Map((Array.isArray(mappings) ? mappings : [])
    .map((mapping) => [String(mapping?.locationId || ''), positiveClinicId(mapping?.clinicaId)]));

  return Array.from(new Set((Array.isArray(existingRecords) ? existingRecords : [])
    .filter((record) => {
      const destinationClinicId = destinationByLocation.get(String(record?.location_id || ''));
      return destinationClinicId && Number(record?.clinica_id) !== destinationClinicId;
    })
    .map((record) => positiveClinicId(record?.clinica_id))
    .filter(Boolean)));
}

function plainObject(value) {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch (_) {
      candidate = {};
    }
  }
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate
    : {};
}

function mergeBusinessProfileRawPayload(currentRaw, providerRaw, metadata = {}) {
  const current = plainObject(currentRaw);
  const provider = plainObject(providerRaw);
  const merged = {
    ...current,
    ...provider,
    accountName: metadata.accountName || provider.accountName || current.accountName || null,
    accountDisplayName: metadata.accountDisplayName
      || provider.accountDisplayName
      || current.accountDisplayName
      || null,
  };

  // Estos campos no pertenecen al payload público de Google. Los genera
  // ClinicaClick durante las sincronizaciones y nunca deben perderse ni poder
  // ser reemplazados por datos reenviados desde el navegador.
  for (const [key, value] of Object.entries(current)) {
    if (key.startsWith('clinicaclick_')) merged[key] = value;
  }
  return merged;
}

function normalizeBusinessProfileVerification(metadataInput) {
  const metadata = plainObject(metadataInput);
  if (typeof metadata.hasVoiceOfMerchant === 'boolean') {
    return {
      verificationStatus: metadata.hasVoiceOfMerchant ? 'VERIFIED' : 'UNVERIFIED',
      isVerified: metadata.hasVoiceOfMerchant,
    };
  }

  // Compatibilidad exclusiva con snapshots antiguos ya persistidos. Estos
  // campos no pertenecen al contrato actual de LocationMetadata.
  const legacyStatus = String(
    metadata.verificationState || metadata.verificationStatus || ''
  ).trim() || null;
  return {
    verificationStatus: legacyStatus,
    isVerified: legacyStatus
      ? legacyStatus.toUpperCase() === 'VERIFIED'
      : metadata.hasBusinessAuthority === true,
  };
}

function accessibleProviderLocationsById(mappings, providerLocations) {
  const byId = new Map();
  for (const location of Array.isArray(providerLocations) ? providerLocations : []) {
    const locationId = String(location?.locationId || location?.id || '').trim();
    if (locationId) byId.set(locationId, location);
  }

  const missing = (Array.isArray(mappings) ? mappings : [])
    .map((mapping) => String(mapping?.locationId || '').trim())
    .filter((locationId) => locationId && !byId.has(locationId));
  if (missing.length) {
    throw mappingInputError(
      'business_profile_location_not_accessible',
      'Alguna ubicación seleccionada no pertenece a la conexión Google autorizada para estas clínicas.'
    );
  }
  return byId;
}

function assertBusinessProfileConnectionCoherence(existingRecords, mappings, googleConnectionId) {
  const requestedLocationIds = new Set((Array.isArray(mappings) ? mappings : [])
    .map((mapping) => String(mapping?.locationId || '').trim())
    .filter(Boolean));
  const expectedConnectionId = positiveClinicId(googleConnectionId);
  const mismatch = (Array.isArray(existingRecords) ? existingRecords : []).find((record) => (
    requestedLocationIds.has(String(record?.location_id || ''))
    && positiveClinicId(record?.google_connection_id) !== expectedConnectionId
  ));
  if (mismatch) {
    throw mappingAccessError(
      'business_profile_connection_mismatch',
      'La ubicación ya está vinculada mediante otra conexión Google y no puede reasignarse desde esta sesión.',
      409
    );
  }
  return true;
}

async function resolveAuthorizedDestinationGoogleConnection({
  userId,
  mappings,
  authorizeDestinations,
  resolveForClinic,
}) {
  const destinationClinicIds = Array.from(new Set((Array.isArray(mappings) ? mappings : [])
    .map((mapping) => positiveClinicId(mapping?.clinicaId))
    .filter(Boolean)));
  if (!destinationClinicIds.length) {
    throw mappingInputError('business_profile_mappings_required', 'Debes seleccionar al menos una clínica.');
  }

  const canWriteDestinations = await authorizeDestinations({
    userId,
    clinicIds: destinationClinicIds,
    access: 'write',
  });
  if (!canWriteDestinations) {
    throw mappingAccessError(
      'business_profile_destination_scope_forbidden',
      'No tienes permisos para gestionar Google Business Profile en todas las clínicas seleccionadas.'
    );
  }

  // La conexión se obtiene exclusivamente desde las clínicas de destino ya
  // autorizadas. clinic_id/group_id aportados por el cliente no intervienen.
  const resolutions = [];
  for (const clinicId of destinationClinicIds) {
    resolutions.push(await resolveForClinic(clinicId));
  }
  const connections = resolutions.map((resolution) => resolution?.connection).filter(Boolean);
  if (connections.length !== destinationClinicIds.length) {
    throw mappingAccessError(
      'business_profile_connection_not_found',
      'No existe una conexión Google disponible para todas las clínicas seleccionadas.',
      404
    );
  }
  const connectionIds = new Set(connections.map((connection) => positiveClinicId(connection?.id)));
  if (connectionIds.has(null) || connectionIds.size !== 1) {
    throw mappingInputError(
      'business_profile_connection_scope_conflict',
      'Las clínicas seleccionadas no comparten la misma conexión Google.'
    );
  }

  return {
    connection: connections[0],
    destinationClinicIds,
    resolutions,
  };
}

module.exports = {
  accessibleProviderLocationsById,
  assertBusinessProfileConnectionCoherence,
  mergeBusinessProfileRawPayload,
  movedOriginClinicIds,
  normalizeBusinessProfileVerification,
  normalizeBusinessProfileLocationMappings,
  positiveClinicId,
  resolveAuthorizedDestinationGoogleConnection,
};
