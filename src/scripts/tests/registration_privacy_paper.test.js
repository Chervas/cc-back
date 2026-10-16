'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const paper = require('../../lib/registration-privacy-paper');
const digital = require('../../lib/bs-privacy-digital-template');
const privacy = require('../../services/appointmentPrivacyEligibility.service');
const now = new Date('2026-10-15T12:00:00.300Z');
const appointment = { id_cita: 11, paciente_id: 2, clinica_id: 72 };
const built = digital.buildBsPrivacyDigitalHtml();
const template = { id: 600, clinic_id: 72, catalog_key: privacy.FINAL_PRIVACY_KEY, purpose: 'data_protection',
  status: 'active', is_default: true, blocking_policy: 'hard' };
const version = { id: 700, clinic_template_id: 600, status: 'published', locale: 'es', version: 2,
  body_html: built.html, body_json: { consent_form: built.consent_form, digital_presentation: built.metadata } };

function fixture() {
  const calls = [], attestations = [], events = [], transaction = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } };
  const Op = Object.fromEntries(['ne', 'lte', 'or', 'in'].map(key => [key, Symbol(key)]));
  const read = (name, value) => ({ findOne: async q => { calls.push([name, q]); assert.equal(q.transaction, transaction);
    assert.equal(q.lock, 'SHARE'); return value; } });
  const db = { Sequelize: { Op }, Paciente: { findByPk: async (id, q) => {
    calls.push(['patient', id, q]); assert.equal(q.transaction, transaction); return { id_paciente: id, clinica_id: 72 };
  } }, ClinicConsentTemplate: read('template', template),
  ClinicConsentTemplateVersion: { ...read('version', version), findAll: async q => {
    assert.equal(q.transaction, transaction); assert.equal(q.lock, 'SHARE'); return [];
  } }, PatientConsentExternalAttestation: {
    findAll: async q => { calls.push(['paper-read', q]); assert.equal(q.transaction, transaction); assert.equal(q.lock, 'SHARE');
      assert.equal(q.limit, 101); return attestations; },
    create: async (values, q) => { calls.push(['paper-write']); assert.equal(q.transaction, transaction);
      const row = { id: attestations.length + 1, ...values }; attestations.push(row); return row; },
  }, PatientOperationalEvent: {
    findAll: async q => { calls.push(['receipt-read', q]); assert.equal(q.transaction, transaction); assert.equal(q.lock, 'SHARE');
      assert.equal(q.limit, 101); return events; },
    create: async (values, q) => { calls.push(['receipt-write']); assert.equal(q.transaction, transaction);
      const row = { id: events.length + 1, ...values }; events.push(row); return row; },
  }, PatientCustomField: { findAll: async () => [] }, CitaPaciente: read('previous-care', null),
  PatientConsentDocument: { findAll: async () => [] } };
  const approvedVersions = new Map([[version.id, { version, digital: true, legacy: false }]]);
  return { db, calls, attestations, events, transaction, approvedVersions,
    record: extra => paper.recordRegistrationPrivacyPaper({ db, appointment, actorId: 7, acknowledged: true, transaction, now, ...extra }),
    find: extra => paper.findRegistrationPrivacyPaper({ db, patientId: 2, clinicId: 72, template, version,
      approvedVersions, transaction, now, ...extra }),
    assess: extra => privacy.assessPrivacyBeforeStart({ db, appointment, transaction, now, ...extra }) };
}

test('reception creates an explicit paper attestation and server receipt, never a patient signature or permissions', async () => {
  const f = fixture(), result = await f.record();
  assert.equal(result.created, true); assert.equal(result.allowed, true); assert.equal(result.reason, 'privacy_received_on_paper');
  assert.equal(result.privacy_satisfied, true); assert.equal(result.privacy_signed, false); assert.equal(result.privacy_on_paper, true);
  assert.equal(f.attestations.length, 1); assert.equal(f.events.length, 1);
  const [attestation] = f.attestations, [event] = f.events;
  assert.equal(attestation.source, paper.PAPER_SOURCE); assert.equal(attestation.status, 'active');
  assert.equal(attestation.attested_by, 7); assert.equal(attestation.purpose, 'data_protection');
  assert.equal(attestation.paciente_id, 2); assert.equal(attestation.clinica_id, 72); assert.equal(attestation.tratamiento_id, null);
  assert.equal(event.metadata.attestation_id, attestation.id); assert.equal(event.metadata.appointment_id, 11);
  assert.equal(event.metadata.catalog_key, privacy.FINAL_PRIVACY_KEY); assert.equal(event.metadata.legal_text_sha256, digital.LEGAL_TEXT_SHA256);
  assert.equal(event.metadata.acknowledged, true); assert.equal(event.actor_user_id, 7);
  assert(!Object.hasOwn(event.metadata, 'consent_choices')); assert(!Object.hasOwn(event.metadata, 'signature_evidence'));
  assert.equal(f.calls[0][0], 'patient'); assert.equal(f.calls[0][2].lock, 'UPDATE');
  assert.deepEqual(await f.find(), result.evidence);
  const assessment = await f.assess(); assert.equal(assessment.reason, 'privacy_received_on_paper'); assert.equal(assessment.privacy_signed, false);
});

test('paper registration is idempotent under the patient lock and reusable for the next appointment in the same clinic', async () => {
  const f = fixture(), first = await f.record(), second = await f.record({ appointment: { ...appointment, id_cita: 12 } });
  assert.equal(first.created, true); assert.equal(second.created, false); assert.deepEqual(second.evidence, first.evidence);
  assert.equal(f.attestations.length, 1); assert.equal(f.events.length, 1);
  assert.equal((await f.assess({ appointment: { ...appointment, id_cita: 12 } })).allowed, true);
});

test('the explicit acknowledgement, actual BS clinic, transaction and actor are required before any write', async () => {
  for (const extra of [{ acknowledged: false }, { acknowledged: 'true' }, { acknowledged: null }, { actorId: null },
    { actorId: -1 }, { transaction: null }, { appointment: { ...appointment, clinica_id: 88 } }]) {
    const f = fixture(); await assert.rejects(f.record(extra)); assert.equal(f.attestations.length, 0); assert.equal(f.events.length, 0);
  }
});

test('a generic external written checkbox or unattested reserved-source row never authorizes care', async () => {
  const f = fixture(); await f.record(); f.events.length = 0;
  assert.equal(await f.find(), null); assert.equal((await f.assess()).allowed, false);
  f.attestations[0].source = 'external_written';
  assert.equal(await f.find(), null); assert.equal((await f.assess()).allowed, false);
});

for (const [label, alter] of [
  ['different patient', f => { f.attestations[0].paciente_id = 3; }],
  ['different clinic', f => { f.attestations[0].clinica_id = 66; }],
  ['treatment-specific', f => { f.attestations[0].tratamiento_id = 12; }],
  ['wrong purpose', f => { f.attestations[0].purpose = 'clinical'; }],
  ['revoked', f => { f.attestations[0].revoked_at = now; }],
  ['revoking actor', f => { f.attestations[0].revoked_by = 7; }],
  ['inactive', f => { f.attestations[0].status = 'revoked'; }],
  ['missing actor', f => { f.attestations[0].attested_by = null; }],
  ['future observation', f => { f.attestations[0].attested_at = new Date(now.getTime() + 1000); }],
  ['wrong event actor', f => { f.events[0].actor_user_id = 8; }],
  ['wrong event patient', f => { f.events[0].patient_id = 3; }],
  ['wrong event clinic', f => { f.events[0].clinic_id = 66; }],
  ['wrong event source', f => { f.events[0].source = 'manual'; }],
  ['wrong event type', f => { f.events[0].event_type = 'generic.attestation'; }],
  ['wrong event channel', f => { f.events[0].channel = 'whatsapp'; }],
  ['future event', f => { f.events[0].occurred_at = new Date(now.getTime() + 1000); }],
  ['wrong attestation receipt', f => { f.events[0].metadata.attestation_id = 99; }],
  ['missing appointment anchor', f => { delete f.events[0].metadata.appointment_id; }],
  ['wrong template', f => { f.events[0].metadata.clinic_template_id = 601; }],
  ['wrong version', f => { f.events[0].metadata.clinic_template_version_id = 701; }],
  ['wrong final catalog', f => { f.events[0].metadata.catalog_key = 'old-lopd'; }],
  ['wrong legal fingerprint', f => { f.events[0].metadata.legal_text_sha256 = 'a'.repeat(64); }],
  ['wrong source fingerprint', f => { f.events[0].metadata.source_document_sha256 = 'a'.repeat(64); }],
  ['acknowledgement absent', f => { f.events[0].metadata.acknowledged = false; }],
  ['caller-shaped extra grant', f => { f.events[0].metadata.allow = true; }],
  ['future receipt', f => { f.events[0].metadata.recorded_at = new Date(now.getTime() + 1000).toISOString(); }],
]) test('paper evidence rejects ' + label, async () => {
  const f = fixture(); await f.record(); alter(f);
  assert.equal(await f.find(), null); assert.equal((await f.assess()).allowed, false);
});

test('revocation immediately restores the privacy gate and reception can record a new observation without rewriting history', async () => {
  const f = fixture(); await f.record(); f.attestations[0].revoked_at = now; f.attestations[0].status = 'revoked';
  const historical = JSON.stringify([f.attestations[0], f.events[0]]);
  assert.equal((await f.assess()).allowed, false);
  const next = await f.record(); assert.equal(next.created, true); assert.equal(next.evidence.attestation_id, 2);
  assert.equal(JSON.stringify([f.attestations[0], f.events[0]]), historical);
  assert.equal((await f.assess()).allowed, true);
});

test('native MySQL second-resolution dates remain valid without accepting a different audit time', async () => {
  const f = fixture(); await f.record();
  f.attestations[0].attested_at = new Date('2026-10-15T12:00:00Z'); f.events[0].occurred_at = new Date('2026-10-15T12:00:00Z');
  assert.equal((await f.find()).kind, 'paper');
  f.events[0].occurred_at = new Date('2026-10-15T11:59:58Z'); assert.equal(await f.find(), null);
});

test('paper reads remain patient/clinic/source scoped, bounded and locked; excess history fails closed', async () => {
  const f = fixture(); await f.record();
  const query = f.calls.find(([name]) => name === 'paper-read')[1];
  assert.deepEqual(query.where, { paciente_id: 2, clinica_id: 72, purpose: 'data_protection',
    source: { [f.db.Sequelize.Op.in]: [paper.PAPER_SOURCE, paper.PATIENT_PAPER_SOURCE] },
    status: 'active', revoked_at: null });
  f.attestations.push(...Array(100).fill(f.attestations[0]));
  await assert.rejects(f.find(), { code: 'appointment_consent_privacy_configuration' });
});

test('patient-level paper receipt needs no invented appointment and remains idempotent and valid for care', async () => {
  const f = fixture();
  const first = await paper.recordPatientRegistrationPrivacyPaper({ db: f.db, patientId: 2, clinicId: 72,
    actorId: 7, acknowledged: true, transaction: f.transaction, now });
  assert.equal(first.created, true); assert.equal(f.events[0].metadata.appointment_id, null);
  assert.equal(f.events[0].metadata.schema_version, paper.PATIENT_PAPER_SOURCE);
  assert.equal(f.attestations[0].source, paper.PATIENT_PAPER_SOURCE);
  assert.equal((await f.find()).kind, 'paper'); assert.equal((await f.assess()).allowed, true);
  const again = await f.record(); assert.equal(again.created, false); assert.equal(f.events.length, 1);
  f.events[0].metadata.appointment_id = 11;
  assert.equal(await f.find(), null, 'v2 cannot forge an appointment-linked receipt');
});
