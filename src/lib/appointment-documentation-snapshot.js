'use strict';

// Clinical text belongs to an immutable approved revision, not to a room,
// machine or phase label. The start event stores exact revision/hash references
// rather than copying large documents or inferring component treatments.
const { createHash } = require('node:crypto');
const SCHEMA = 'appointment-documentation/1';
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => createHash('sha256').update(canonical(clone(value))).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { statusCode: 409, code }); };
const instant = value => { const date = new Date(value); return value != null && Number.isFinite(+date)
  ? new Date(Math.floor(+date / 1000) * 1000).toISOString() : null; };

function exactApprovedRevision(revision, reference, clinicId, treatmentIds) {
  const snapshot = revision?.snapshot;
  if (!snapshot || Number(revision.protocol_id) !== Number(reference.id) || Number(revision.version) !== Number(reference.version)
    || Number(snapshot.id) !== Number(reference.id) || Number(snapshot.version) !== Number(reference.version)
    || Number(snapshot.clinic_id) !== Number(clinicId) || snapshot.status !== 'approved'
    || !['protocol', 'aftercare'].includes(snapshot.kind) || !positive(snapshot.approved_by) || !instant(snapshot.approved_at)
    || typeof snapshot.title !== 'string' || !snapshot.title.trim() || typeof snapshot.content !== 'string' || !snapshot.content.trim()
    || typeof snapshot.source !== 'string' || !snapshot.source.trim() || !Array.isArray(snapshot.treatment_ids)
    || !snapshot.treatment_ids.some(id => positive(id) && treatmentIds.includes(Number(id)))) return null;
  if (reference.snapshot_sha256 && digest(snapshot) !== reference.snapshot_sha256) return null;
  return { id: Number(snapshot.id), version: Number(snapshot.version), kind: snapshot.kind, title: snapshot.title,
    content: snapshot.content, source: snapshot.source, approved_at: snapshot.approved_at, status: 'approved' };
}

function sealSnapshot(value) {
  const body = clone({ ...value, schema: SCHEMA });
  delete body.sha256;
  if (!positive(body.appointment_id) || !positive(body.clinic_id) || !positive(body.patient_id)
    || !instant(body.schedule_start) || !instant(body.started_at) || !Array.isArray(body.treatment_ids)
    || body.treatment_ids.some(id => !positive(id)) || new Set(body.treatment_ids.map(Number)).size !== body.treatment_ids.length
    || !Array.isArray(body.revisions) || body.revisions.some(ref => !positive(ref.id) || !positive(ref.version)
      || !/^[a-f0-9]{64}$/.test(ref.snapshot_sha256 || ''))
    || new Set(body.revisions.map(ref => `${ref.id}:${ref.version}`)).size !== body.revisions.length
    || (body.clinical_context_source != null && (!positive(body.clinical_appointment_id)
      || !['appointment', 'validated_clinical_component_parent'].includes(body.clinical_context_source)
      || (body.clinical_context_source === 'appointment' && Number(body.clinical_appointment_id) !== Number(body.appointment_id))
      || (body.clinical_context_source === 'validated_clinical_component_parent' && (Number(body.clinical_appointment_id) === Number(body.appointment_id)
        || !/^[1-9][0-9]{0,19}$/.test(body.clinical_relation_audit_event_id || '')
        || !/^[a-f0-9]{64}$/.test(body.clinical_relation_receipt_sha256 || '')))))
    || !Number.isSafeInteger(body.draft_count) || body.draft_count < 0) {
    fail('appointment_documentation_snapshot_invalid', 'La referencia documental de inicio no es válida.');
  }
  return { ...body, sha256: digest(body) };
}

function readSnapshot(value, { appointment, careEvent, operationalEvent }) {
  const a = appointment?.toJSON ? appointment.toJSON() : appointment;
  const event = operationalEvent?.toJSON ? operationalEvent.toJSON() : operationalEvent;
  const care = careEvent?.toJSON ? careEvent.toJSON() : careEvent;
  if (!value) return null;
  if (value.schema !== SCHEMA) fail('appointment_documentation_snapshot_changed', 'No se puede verificar la versión documental conservada al iniciar esta cita.');
  const { sha256, ...body } = value;
  if (!/^[a-f0-9]{64}$/.test(sha256 || '') || digest(body) !== sha256
    || Number(value.appointment_id) !== Number(a.id_cita) || Number(value.clinic_id) !== Number(a.clinica_id)
    || Number(value.patient_id) !== Number(a.paciente_id) || instant(value.schedule_start) !== instant(a.care_schedule_start)
    || instant(value.started_at) !== instant(a.care_started_at)
    || !event || event.event_type !== 'appointment_care_changed' || event.source !== 'agenda'
    || Number(event.patient_id) !== Number(a.paciente_id) || Number(event.clinic_id) !== Number(a.clinica_id)
    || event.metadata?.action !== 'start' || Number(event.metadata?.appointment_id) !== Number(a.id_cita)
    || !care || Number(care.id) !== Number(event.metadata?.care_event_id) || care.action !== 'start'
    || Number(care.appointment_id) !== Number(a.id_cita) || Number(care.clinic_id) !== Number(a.clinica_id)
    || !positive(care.actor_id) || Number(care.actor_id) !== Number(event.actor_user_id)
    || Number(care.actor_id) !== Number(a.care_started_by) || instant(care.schedule_start) !== instant(value.schedule_start)
    || instant(care.created_at) !== instant(value.started_at) || instant(event.occurred_at) !== instant(value.started_at)) {
    fail('appointment_documentation_snapshot_changed', 'No se puede verificar la versión documental conservada al iniciar esta cita.');
  }
  // Validate the shape again; a digest is integrity evidence, not authorization
  // or a substitute for the exact appointment and append-only care event.
  sealSnapshot(body);
  return clone(value);
}

module.exports = { SCHEMA, digest, instant, exactApprovedRevision, sealSnapshot, readSnapshot };
