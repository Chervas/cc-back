'use strict';

const { SOURCE_BATCH } = require('./cliniccloud-import/catalog-retirement');
const object = value => { if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; };
const protectedKey = key => key === 'raw' || key.startsWith('cliniccloud_') || key.startsWith('source_');
const positive = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));

// Intentional API compatibility change: HTTP/generic writers may echo these
// namespaces but can no longer author, replace or erase them. Non-source JSON
// remains editable. Direct verified importers write their server evidence to
// the model first; subsequent generic booking preserves that original row.
function mergeAppointmentSourceMetadata(previous, incoming) {
  const before = object(previous), next = { ...before, ...object(incoming) };
  for (const key of Object.keys(next)) if (protectedKey(key)) delete next[key];
  for (const [key, value] of Object.entries(before)) if (protectedKey(key)) next[key] = value;
  return next;
}

function assertGenericSourceIdentity(previous, requested) {
  const before = previous || {}, patch = requested || {};
  const isClinicCloud = value => String(value || '').trim().toLowerCase() === 'cliniccloud';
  if ((!isClinicCloud(before.source_system) && isClinicCloud(patch.source_system))
    || isClinicCloud(before.source_system) && ['source_system', 'source_reference'].some(key => Object.hasOwn(patch, key)
      && patch[key] !== before[key])) throw Object.assign(new Error('La procedencia de ClinicCloud sólo la puede registrar o corregir su importador verificado.'), {
    code: 'booking_import_provenance_server_owned', status: 409, statusCode: 409,
  });
}

function exactImportedTreatmentBinding(treatment, appointment) {
  const config = object(treatment?.clinical_config), metadata = object(appointment?.import_metadata);
  const serviceId = config.raw?.idServicio, appointmentId = metadata.source_appointment_id;
  // Conservative exemption: HTTP appointments always have their creator. An
  // old row without this exact original import identity must be reviewed, not
  // granted a name-based continuation bypass. Refreshed source acts also need
  // their own exact equivalence; never reuse the previous service ID for them.
  return appointment?.source_system === 'cliniccloud' && Object.hasOwn(appointment, 'created_by') && appointment.created_by === null
    && metadata.source_account === 'cliniccloud-5880' && !metadata.cliniccloud_source_refreshes
    && positive(appointmentId) && appointment.source_reference === `appointment:${appointmentId}`
    && String(metadata.raw?.idCita) === String(appointmentId)
    && positive(metadata.source_contact_id) && String(metadata.raw?.idContacto) === String(metadata.source_contact_id)
    && positive(serviceId) && String(metadata.source_service_id) === String(serviceId)
    && String(metadata.raw?.idServicio) === String(serviceId)
    && treatment?.origen === 'clinica' && Number(treatment.clinica_id) === Number(appointment.clinica_id)
    && config.source_system === 'cliniccloud' && config.source_batch === SOURCE_BATCH
    && treatment.codigo === `CCLOUD-${serviceId}` && config.source_reference === `service:${serviceId}`;
}

module.exports = { mergeAppointmentSourceMetadata, assertGenericSourceIdentity, exactImportedTreatmentBinding };
