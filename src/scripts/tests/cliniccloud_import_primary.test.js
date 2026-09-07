'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../../lib/cliniccloud-import/primary-clinics');

test('renamed historical block type does not erase nutrition, and actual blocks are excluded', () => {
  assert.equal(p.serviceClinic({ idServicio: '1001285', idTipoServicio: '90560', nombre: 'PRIMERA CONSULTA NUTRICIÓN' }).clinic_id, 72);
  assert.equal(p.serviceClinic({ idServicio: '1076290', idTipoServicio: '90560', nombre: 'BLOQUEO AGENDA 4 HORAS' }).blocked, true);
  assert.equal(p.serviceClinic({ idServicio: '2951044', idTipoServicio: '90530', nombre: 'INJERTO CAPILAR' }).clinic_id, 66);
  assert.equal(p.serviceClinic({ idServicio: '1001350', idTipoServicio: '90525', nombre: 'PRP FACIAL Y CAPILAR' }).clinic_id, null);
});
test('historical concepts resolve service and patient by exact parent ID, never status 3 as payment', () => {
  const args = { appointments: [{ idCita: 'a', idContacto: 'patient-a', fechaIni: '03/02/2020', estado: '3', pagado: '0' }],
    concepts: [{ idCitaConcepto: '1', idCita: 'a', idContacto: 'patient-a', idServicio: '20', pagado: '0' }],
    services: [{ idServicio: '20', idTipoServicio: '260902', nombre: 'PRP' }] };
  const result = p.historicalEvidence(args);
  assert.equal(result.evidence[0].clinic_id, 66); assert.equal(result.evidence[0].paid_evidence, false);
  assert.equal(result.evidence[0].treatment_date, '2020-02-03');
  args.concepts[0].idContacto = 'wrong-patient';
  assert.equal(p.historicalEvidence(args).excluded[0].reason, 'CONCEPT_APPOINTMENT_PATIENT_MISMATCH');
});
test('CSV literal Pagada qualifies as state evidence and mixed clinics remain ambiguous', () => {
  const rows = [{ IDCONTACTO: '1', FECHA: '01/09/2026', ESTADO: 'Pagada', SERVICIOS: 'Servicio', 'TIPO SERVICIO': 'CAPILAR', 'PAGADO CITA': '0' }];
  const types = [{ idTipoServicio: '260902', nombre: 'CAPILAR' }, { idTipoServicio: '90525', nombre: 'MEDICINA ESTÉTICA FACIAL' }];
  const result = p.newEvidence(rows, types);
  assert.equal(result.evidence[0].payment_evidence_kind, 'literal_export_state_pagada_not_money');
  rows[0]['TIPO SERVICIO'] = 'CAPILAR-MEDICINA ESTÉTICA FACIAL';
  assert.equal(p.newEvidence(rows, types).evidence[0].clinic_id, null);
});
const evidence = (clinic, date, paid = false) => ({ source_contact_id: '1', treatment_id: 't', clinic_id: clinic, treatment_date: date, paid_evidence: paid });
const patient = { id: 8, clinic_id: 72, source_contact_ids: ['1'], source_history_numbers: ['300'] };
test('oldest paid treatment outranks oldest unpaid, preserving current clinic access membership', () => {
  const result = p.assignmentPlan({ evidence: [evidence(72, '2020-01-01'), evidence(66, '2026-08-01', true)], patients: [patient], memberships: [{ paciente_id: 8, clinica_id: 72, es_principal: true }] });
  const row = result.assignments[0];
  assert.equal(row.proposed_clinic_id, 66); assert.equal(row.action, 'move_primary_candidate');
  assert.deepEqual(row.memberships.add, [66]); assert.deepEqual(row.memberships.remove, []);
});
test('earlier ambiguous paid/recorded treatment and same-day clinic ties cannot silently move patients', () => {
  for (const records of [[evidence(null, '2019-01-01'), evidence(66, '2020-01-01')], [evidence(72, '2020-01-01'), evidence(66, '2020-01-01')], [evidence(null, '2021-01-01', true), evidence(66, '2020-01-01')]]) {
    const row = p.assignmentPlan({ evidence: records, patients: [patient] }).assignments[0];
    assert.equal(row.action, 'review'); assert.equal(row.proposed_clinic_id, null);
  }
});
test('alerts require unique existing source ID plus confirmed history NUM, not a similar IDCONTACTO', () => {
  const alert = { kind: 'followup', source_contact_id: '1', history_number: '300', status: 'pending', body: 'Revisión capilar', contact_due_at: '2026-09-08T00:00:00', validation_errors: [] };
  const args = { alerts: [alert], patients: [patient], assignments: [], memberships: [{ paciente_id: 8, clinica_id: 66 }] };
  const row = p.alertPlan(args).rows[0];
  assert.equal(row.action, 'ready_existing_identity'); assert.equal(row.clinic_id, 66);
  assert.equal(row.payload.clinical_target_date, null); assert.equal(row.automation_policy, 'hold');
  alert.history_number = '1'; assert.equal(p.alertPlan(args).rows[0].action, 'review');
});
test('generic followup for dual-clinic patient does not inherit principal clinic blindly', () => {
  const row = p.alertPlan({ alerts: [{ kind: 'followup', source_contact_id: '1', history_number: '300', status: 'closed', body: 'Revisión anual', contact_due_at: '2020-01-01T00:00:00', validation_errors: [] }], patients: [patient],
    assignments: [{ local_patient_id: 8, action: 'preserve_primary', evidence_clinic_ids: [66, 72] }] }).rows[0];
  assert.equal(row.action, 'review'); assert.equal(row.payload.status, 'closed'); assert.equal(row.clinic_id, null);
});
