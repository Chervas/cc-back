'use strict';

const { hash, norm } = require('./cliniccloud-import/adapter');
const MODE = 'historical_reference';
const VERSION = 'historical-treatment-reference/1';
const SHA = /^[a-f0-9]{64}$/;
const error = (code, message, status = 422) => Object.assign(new Error(message), { code, status, statusCode: status });
function object(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw error('historical_reference_invalid', 'La referencia histórica no es válida.'); } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
const plain = value => value?.toJSON ? value.toJSON() : value;
const config = value => object(plain(value)?.clinical_config);
function positive(value) {
  if (!['number', 'string'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw error('historical_reference_invalid', 'La referencia histórica necesita identificadores válidos.');
  return Number(value);
}
function isHistoricalTreatment(value) {
  const cfg = config(value);
  return cfg.catalog_status === MODE || object(cfg.commercial).sale_mode === MODE || cfg.historical_reference != null;
}
function sourceProjection(raw) {
  const row = plain(raw), metadata = object(row?.import_metadata);
  const source = object(object(metadata.cliniccloud_delta).source);
  const booking = object(metadata.booking);
  if (row?.source_system !== 'cliniccloud' || source.kind !== 'appointment' || !String(row.source_reference || '').startsWith('delta:')
    || !metadata.source_account || !source.service_key || !booking.profile || !Array.isArray(booking.phases) || !booking.phases.length) {
    throw error('historical_reference_source_required', 'Sólo se pueden clasificar reservas ClinicCloud existentes con procedencia y reserva conservadas.');
  }
  const primaryId = String(positive(metadata.source_appointment_id));
  if (String(positive(source.source_external_id)) !== primaryId) throw error('historical_reference_source_mismatch', 'La reserva y la cita fuente no coinciden.');
  const sources = [{ id: primaryId, source }];
  const parallel = object(metadata.cliniccloud_parallel_sources);
  if (parallel.entries != null) {
    if (!Array.isArray(parallel.entries) || parallel.source_account !== metadata.source_account) throw error('historical_reference_source_mismatch', 'Las reservas paralelas no pertenecen a la misma fuente.');
    for (const entry of parallel.entries) {
      const id = String(positive(entry?.source_appointment_id));
      const content = object(entry?.source);
      if (!content.service_key) throw error('historical_reference_source_required', 'Falta el acto fuente de una reserva paralela.');
      if (!sources.some(item => item.id === id)) sources.push({ id, source: content });
    }
  }
  sources.sort((a, b) => Number(a.id) - Number(b.id));
  // Derive from stored server rows, including current notes; input hashes never
  // establish a clinical act, a price, an administration or an approval.
  return { source_account: metadata.source_account, source_ids: sources.map(item => item.id),
    sources: sources.map(item => ({ id: item.id, service_key: item.source.service_key, details: item.source.details ?? '',
      agenda_key: item.source.agenda_key ?? '', start: item.source.start_utc ?? item.source.start_local,
      end: item.source.end_utc ?? item.source.end_local, provenance: item.source.provenance ?? null })),
    current_note: row.nota ?? null, current_reason: row.motivo ?? null,
    booking_profile: booking.profile, booking_phases: booking.phases,
    preserved_source_booking: metadata.cliniccloud_source_booking ?? null,
    parallel_sources: metadata.cliniccloud_parallel_sources ?? null };
}
function reservationProjection(raw) {
  const row = plain(raw), value = {};
  // Operational state/care timestamps may advance; identity, resources, time,
  // source, notes, visit type and historical economic references may not drift.
  for (const key of ['id_cita', 'clinica_id', 'paciente_id', 'lead_intake_id', 'doctor_id', 'instalacion_id', 'inicio', 'fin', 'tipo_cita',
    'titulo', 'nota', 'motivo', 'source_system', 'source_reference', 'voucher_id', 'campana_id', 'es_provisional', 'hold_expires_at']) value[key] = row[key] ?? null;
  for (const key of ['inicio', 'fin', 'hold_expires_at']) if (value[key] !== null) {
    const date = new Date(value[key]);
    if (!Number.isFinite(date.getTime())) throw error('historical_reference_invalid', 'La reserva histórica necesita fechas válidas.');
    value[key] = date.toISOString();
  }
  if (value.es_provisional !== null) {
    if (![false, true, 0, 1].includes(value.es_provisional)) throw error('historical_reference_invalid', 'La reserva histórica tiene un estado provisional no válido.');
    value.es_provisional = Boolean(value.es_provisional);
  }
  value.booking = object(row.import_metadata).booking;
  return value;
}
function rowEvidence(raw) {
  const row = plain(raw), source = sourceProjection(row);
  return { appointment_id: positive(row.id_cita), clinic_id: positive(row.clinica_id), source_account: source.source_account,
    source_appointment_ids: source.source_ids, source_projection_sha256: hash(source),
    reservation_sha256: hash(reservationProjection(row)), current_note_sha256: hash(row.nota ?? null),
    act_sha256: hash(source.sources.map(item => ({ service_key: item.service_key, details: item.details }))),
    booking_sha256: hash({ profile: source.booking_profile, phases: source.booking_phases }) };
}
function clinicalDocumentReviewRequired(value) {
  return isHistoricalTreatment(value) && config(value).historical_reference?.required_clinical_document_review !== false;
}
function validateHistoricalReference(raw) {
  const value = plain(raw), cfg = config(value), ref = object(cfg.historical_reference);
  if (cfg.catalog_status !== MODE || object(cfg.commercial).sale_mode !== MODE || value.precio_base !== null || ![false, 0].includes(value.activo)
    || value.origen !== 'clinica' || cfg.price_profile != null || cfg.source_price != null || cfg.imported_price_review != null
    || value.appointment_automation_template_key != null || Object.keys(object(value.automation_template_bindings)).length
    || cfg.booking_profile != null || ref.version !== VERSION || ref.clinical_approval_inferred !== false
    || ref.nonbillable !== true || typeof ref.required_clinical_document_review !== 'boolean'
    || !Number.isSafeInteger(ref.reviewed_by) || ref.reviewed_by <= 0 || !Number.isFinite(Date.parse(ref.reviewed_at))
    || !Array.isArray(ref.rows) || !ref.rows.length || ref.rows.length > 100 || !SHA.test(ref.binding_sha256 || '')) {
    throw error('historical_reference_invalid', 'La referencia histórica debe permanecer inactiva, sin tarifa, automatización ni oferta comercial.');
  }
  const clinicId = positive(value.clinica_id), seen = new Set();
  for (const row of ref.rows) {
    positive(row.appointment_id);
    if (seen.has(row.appointment_id) || row.clinic_id !== clinicId || row.source_account !== ref.source_account
      || !Array.isArray(row.source_appointment_ids) || !row.source_appointment_ids.length || row.source_appointment_ids.some(id => String(positive(id)) !== id)
      || new Set(row.source_appointment_ids).size !== row.source_appointment_ids.length
      || ['source_projection_sha256', 'reservation_sha256', 'current_note_sha256', 'act_sha256', 'booking_sha256'].some(key => !SHA.test(row[key] || ''))) {
      throw error('historical_reference_invalid', 'La evidencia histórica no corresponde a un conjunto exacto de reservas de la misma clínica.');
    }
    seen.add(row.appointment_id);
  }
  const body = { ...ref }; delete body.binding_sha256;
  if (hash({ clinic_id: clinicId, ...body }) !== ref.binding_sha256) throw error('historical_reference_invalid', 'La evidencia histórica ha cambiado.');
  return ref;
}
function assertReviewedHistoricalTreatment({ treatment, row }) {
  const ref = validateHistoricalReference(treatment), actual = rowEvidence(row);
  const expected = ref.rows.find(item => item.appointment_id === actual.appointment_id);
  if (!expected || Number(plain(treatment).clinica_id) !== actual.clinic_id || hash(expected) !== hash(actual)
    || (plain(row).tratamiento_id != null && Number(plain(row).tratamiento_id) !== Number(plain(treatment).id_tratamiento))) {
    throw error('historical_reference_reservation_mismatch', 'La referencia histórica sólo clasifica las reservas fuente exactas revisadas; no admite nuevos actos, cambios de agenda o de precio.', 409);
  }
  return { sale_mode: MODE, nonbillable: true, booking_ready: false, clinical_approval_inferred: false,
    required_clinical_document_review: ref.required_clinical_document_review, binding_sha256: ref.binding_sha256 };
}
function buildHistoricalReferenceValues({ rows, actorId, discipline, now = new Date(), requiredClinicalDocumentReview = true }) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 100 || typeof requiredClinicalDocumentReview !== 'boolean') throw error('historical_reference_invalid', 'Revisa el conjunto acotado de reservas históricas.');
  if (typeof discipline !== 'string' || !/^[a-z][a-z0-9_]{1,49}$/.test(discipline)) throw error('historical_reference_discipline_required', 'El servicio debe derivar el área de la clínica, sin inferir una indicación clínica nueva.');
  const values = rows.map(plain), evidence = values.map(rowEvidence).sort((a, b) => a.appointment_id - b.appointment_id);
  const clinicId = evidence[0].clinic_id, account = evidence[0].source_account;
  if (new Set(evidence.map(item => item.appointment_id)).size !== evidence.length || evidence.some(item => item.clinic_id !== clinicId || item.source_account !== account)
    || values.some(item => item.tratamiento_id != null)) throw error('historical_reference_scope', 'La referencia necesita reservas sin clasificación de una única clínica y fuente.', 409);
  const projections = values.map(sourceProjection);
  const noLedDutas = projections.every(item => item.sources.every(source => /\bDUTAS(?:TERIDE)?\b/.test(norm(source.details))
    && !/\b(PRP|PLASMA|LED|INDIBA|CARBOXI(?:TERAPIA)?|EXTRACCION)\b/.test(norm(source.details + ' ' + source.service_key)))
    && !item.booking_profile.phases.some(phase => (phase.equipment_requirements || []).some(group => (group.equipment_ids || []).includes(15))));
  const serviceKeys = [...new Set(projections.flatMap(item => item.sources.map(source => source.service_key)))].sort();
  const name = noLedDutas ? 'Dutasteride · referencia histórica de reserva (LED no documentado)'
    : (serviceKeys.join(' + ').slice(0, 215) + ' · referencia histórica');
  const reference = { version: VERSION, source_account: account, reviewed_by: positive(actorId), reviewed_at: now.toISOString(),
    nonbillable: true, clinical_approval_inferred: false, required_clinical_document_review: requiredClinicalDocumentReview,
    source_services: serviceKeys, rows: evidence };
  reference.binding_sha256 = hash({ clinic_id: clinicId, ...reference });
  const result = { nombre: name, descripcion: 'Clasificación de reservas fuente ya existentes. Sin tarifa ni nueva oferta, reserva, administración o aprobación clínica.',
    disciplina: discipline, categoria: 'Referencia histórica', duracion_min: null, precio_base: null,
    origen: 'clinica', clinica_id: clinicId, grupo_clinica_id: null, activo: false, sesiones_defecto: 1,
    appointment_automation_template_key: null, automation_template_bindings: null,
    clinical_config: { catalog_status: MODE, commercial: { sale_mode: MODE }, product_type: MODE, historical_reference: reference } };
  validateHistoricalReference(result);
  return result;
}

module.exports = { MODE, VERSION, isHistoricalTreatment, sourceProjection, reservationProjection, rowEvidence,
  clinicalDocumentReviewRequired, validateHistoricalReference, assertReviewedHistoricalTreatment, buildHistoricalReferenceValues };
