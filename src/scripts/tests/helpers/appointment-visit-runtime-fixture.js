'use strict';

const { randomUUID } = require('node:crypto');
const { combinedAppointment, NOW } = require('./appointment-visit-fixture');
const v = require('../../../lib/appointment-visit-communication');
const r = require('../../../lib/appointment-visit-runtime-contract');
function template(overrides = {}) {
  return { id: 42, public_id: 'fixture_visit_details', template_key: 'fixture_visit_details', version: 1,
    engine_version: 'v2', is_active: true, clinic_id: 66, group_id: null, published_at: NOW, created_by: 7,
    name: 'Owned SQL fixture only', trigger_type: 'appointment_created', trigger_config: {}, entry_node_id: 'T',
    nodes: [
      { id: 'T', type: 'trigger/appointment_created', outputs: { on_success: 'S' } },
      { id: 'S', type: 'action/send_whatsapp', config: {}, outputs: { on_success: 'W' } },
      { id: 'W', type: 'delay/wait_response', config: { listens_to_node_id: 'S', timeout_duration: 2, timeout_unit: 'hours' }, outputs: { on_response: 'A', on_timeout: 'F' } },
      { id: 'A', type: 'action/send_whatsapp', config: {}, outputs: { on_success: 'E' } },
      { id: 'F', type: 'action/send_whatsapp', config: {}, outputs: { on_success: 'E' } },
      { id: 'E', type: 'control/end', outputs: {} },
    ], ...overrides };
}
function stages(source = 'details') {
  return [{ key: source, node_ids: ['S'], wait_node_ids: ['W'] },
    { key: source === 'details' ? 'ack_details' : 'ack_attendance', node_ids: ['A'], source_key: source },
    { key: source === 'details' ? 'timeout_details' : 'timeout_attendance', node_ids: ['F'], source_key: source, timeout_grace_ms: 300000 }];
}
function plan(row = combinedAppointment()) {
  return { start_at: row.inicio, end_at: row.fin, doctor_id: row.doctor_id, installation_id: row.instalacion_id,
    treatment_id: row.tratamiento_id, booking: structuredClone(row.import_metadata.booking),
    ...(row.import_metadata.additional_staff ? { additional_staff: structuredClone(row.import_metadata.additional_staff) } : {}) };
}
function contract(value = template(), source = 'details', timeZone = 'Europe/Madrid') {
  return r.compileEnrollmentContract({ clinicId: 66, timeZone, manifests: [{ template: value, stages: stages(source) }] });
}
function enrolledVisit({ row = combinedAppointment(), value = template(), source = 'details', timeZone, enrolledAt = NOW } = {}) {
  const id = randomUUID(), compiled = r.compiledContract(contract(value, source, timeZone));
  const runtime_enrollment = { ...compiled, birth_request_key: randomUUID(), birth_request_sha256: r.birthRequestHash({ clinicId: 66, patientId: 8, plan: plan(row) }),
    enrolled_at: enrolledAt, actor_id: 7 };
  return { id, clinic_id: 66, patient_id: 8, owner_appointment_id: row.id_cita, grouping_kind: 'singleton', communication_revision: 1,
    ...v.buildVisitSnapshot({ visitId: id, ownerAppointmentId: row.id_cita, appointments: [row], groupingKind: 'singleton',
      members: [{ visit_id: id, appointment_id: row.id_cita, clinic_id: 66, patient_id: 8, role: 'primary', evidence: {} }] }),
    runtime_enrollment, runtime_enrollment_sha256: v.hash(runtime_enrollment) };
}
const healthyInbox = time => ({ version: 1, observedAt: new Date(time).getTime(), recoveryHold: false,
  clinics: [{ clinicId: 66, blockingReview: 0, oldestPendingAt: null }] });
module.exports = { template, stages, plan, contract, enrolledVisit, healthyInbox };
