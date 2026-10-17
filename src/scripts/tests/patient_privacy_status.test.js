'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const Sequelize = require('sequelize');
const status = require('../../services/patientPrivacyStatus.service');
const privacy = require('../../services/appointmentPrivacyEligibility.service');
const choices = require('../../lib/consent-document-choices');
const paper = require('../../lib/registration-privacy-paper');
const digital = require('../../lib/bs-privacy-digital-template');
const now = new Date('2026-10-16T12:00:00Z'), appointment = { id_cita: 11, paciente_id: 2, clinica_id: 72 };
const built = digital.buildBsPrivacyDigitalHtml();
const template = { id: 600, clinic_id: 72, catalog_key: privacy.FINAL_PRIVACY_KEY, purpose: 'data_protection',
  status: 'active', is_default: true, blocking_policy: 'hard', requires_professional_signature: false };
const version = { id: 700, clinic_template_id: 600, version: 2, locale: 'es', status: 'published', body_html: built.html,
  body_json: { consent_form: built.consent_form, digital_presentation: built.metadata } };
const pending = { id: 800, public_id: 'cdoc_qa', paciente_id: 2, clinica_id: 72, clinic_template_id: 600,
  clinic_template_version_id: 700, purpose: 'data_protection', status: 'pending', package_id: 900, title: 'LOPD',
  snapshot_json: { template, version: { id: 700, body_json: version.body_json } }, snapshot_html: built.html,
  snapshot_hash: 'not-yet-signed', revoked_at: null, expires_at: null };
const pkg = { id: 900, paciente_id: 2, clinica_id: 72, status: 'pending', expires_at: '2026-10-17T12:00:00Z' };
function signedDocument() {
  const doc = structuredClone(pending); doc.status = 'signed'; doc.signed_at = '2026-10-16T11:00:00Z';
  doc.snapshot_json.integrity = { algorithm: choices.CHOICE_HASH_ALGORITHM };
  doc.snapshot_json.signature_evidence = { accepted_statement: true, signed_at: doc.signed_at,
    consent_choices: { schema_version: choices.CHOICE_SCHEMA_VERSION,
      answers: Object.fromEntries(choices.CHOICE_KEYS.map(key => [key, 'no'])) } };
  doc.snapshot_html = choices.appendSignedChoiceHtml(built.html.trim(), doc, doc.snapshot_json.signature_evidence.consent_choices);
  doc.snapshot_hash = choices.choiceSnapshotHash(doc.snapshot_json, doc.snapshot_html); return doc;
}
function fixture(options = {}) {
  const calls = [], transaction = { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' } }, db = { Sequelize };
  const data = { templates: [template], versions: [version], imported: [], care: [], documents: [], packages: [pkg],
    deliveries: [], attestations: [], events: [], ...options };
  for (const [model, name] of [['ClinicConsentTemplate', 'templates'], ['ClinicConsentTemplateVersion', 'versions'],
    ['PatientCustomField', 'imported'], ['CitaPaciente', 'care'], ['PatientConsentDocument', 'documents'],
    ['ConsentSignaturePackage', 'packages'], ['ConsentDeliveryEvent', 'deliveries'],
    ['PatientConsentExternalAttestation', 'attestations'], ['PatientOperationalEvent', 'events']]) {
    db[model] = { findAll: async query => { calls.push([name, query]); assert.equal(query.transaction, transaction);
      assert.equal(query.lock, undefined); assert(query.limit > 0); return data[name]; } };
  }
  return { db, data, transaction, calls,
    run: extra => status.getPatientPrivacyStatus({ db, patientId: 2, clinicId: 72, appointmentId: 11, transaction, now, ...extra }),
    load: appointments => status.loadPrivacyContext({ db, appointments, transaction, now }) };
}
test('new patient is required without inventing a request; imported patient keeps its care exemption and missing-LOPD action', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.state, 'not_requested'); assert.equal(result.required, true); assert.equal(result.allowed, false);
  assert.equal(result.attention_required, true); assert.equal(result.has_pending, false); assert.equal(result.document_id, null);
  assert.equal(result.updated_at, null, 'a read clock is not a documentation mutation');
  const imported = await fixture({ imported: [{ paciente_id: 2, value: '1075' }] }).run();
  assert.equal(imported.state, 'not_requested'); assert.equal(imported.required, false); assert.equal(imported.allowed, true);
  assert.equal(imported.attention_required, true); assert.equal(imported.reason, 'existing_imported_patient');
  assert.equal(imported.has_pending, false); assert.equal(imported.document_id, null); assert.equal(imported.package_id, null);
});
test('prior care excludes current appointment and is aggregated in one bounded query', async () => {
  const f = fixture({ care: [{ paciente_id: 2, clinica_id: 72, first_care_id: 11, last_care_id: 11 }] });
  assert.equal((await f.run()).required, true); assert.equal((await f.run({ appointmentId: null })).required, false);
  f.data.care[0].last_care_id = 12; assert.equal((await f.run()).reason, 'existing_clinical_patient');
  assert.deepEqual(f.calls.find(([name]) => name === 'care')[1].group, ['paciente_id', 'clinica_id']);
});
test('an imported patient with a genuine active request still has a visible pending action', async () => {
  const result = await fixture({ imported: [{ paciente_id: 2, value: '1075' }], documents: [pending] }).run();
  assert.equal(result.state, 'pending'); assert.equal(result.required, false); assert.equal(result.has_pending, true);
  assert.equal(result.attention_required, true); assert.equal(result.package_id, 900);
});
for (const [documentStatus, deliveryStatus, expected] of [['sent', null, 'sent'], ['viewed', null, 'viewed'],
  ['pending', 'queued', 'sent'], ['pending', 'sent', 'sent'], ['pending', 'viewed', 'viewed']]) {
  test(`current request ${documentStatus}/${deliveryStatus} yields ${expected}`, async () => {
    const result = await fixture({ documents: [{ ...pending, status: documentStatus }], deliveries: deliveryStatus
      ? [{ id: 3, package_id: 900, patient_consent_document_id: 800, channel: 'tablet', status: deliveryStatus, createdAt: now }] : [] }).run();
    assert.equal(result.state, expected); assert.equal(result.has_pending, true); assert.equal(result.allowed, false);
  });
}
for (const [label, patch, packagePatch] of [['cancelled document', { status: 'cancelled' }], ['revoked document', { revoked_at: now }],
  ['old pending version', { clinic_template_version_id: 699 }], ['expired document', { expires_at: now }],
  ['foreign document', { paciente_id: 3 }], ['foreign clinic document', { clinica_id: 66 }],
  ['cancelled package', {}, { status: 'cancelled' }], ['expired package', {}, { expires_at: now }],
  ['foreign package', {}, { paciente_id: 3 }]]) {
  test(`${label} never resurrects a pending request`, async () => {
    const result = await fixture({ documents: [{ ...pending, ...patch }], packages: [{ ...pkg, ...packagePatch }] }).run();
    assert.equal(result.state, 'not_requested'); assert.equal(result.document_id, null); assert.equal(result.package_id, null);
  });
}
test('valid exact signed evidence wins over newer request and exposes only document display metadata', async () => {
  const result = await fixture({ documents: [{ ...pending, id: 801 }, signedDocument()] }).run();
  assert.equal(result.state, 'signed'); assert.equal(result.allowed, true); assert.equal(result.has_pending, false);
  assert.equal(result.attention_required, false); assert.equal(result.document_id, 800);
  assert.deepEqual(Object.keys(result.document).sort(), ['id', 'public_id', 'signed_at', 'status', 'title']);
  assert.equal(result.package_id, null); assert(!JSON.stringify(result).includes('consent_choices'));
  assert(!JSON.stringify(result).includes('snapshot')); assert(!JSON.stringify(result).includes('token'));
});
test('tampered, incomplete or future signatures never hide a pending requirement', async () => {
  for (const patch of [{ snapshot_html: '<p>altered</p>' }, { signed_at: '2026-10-17T12:00:00Z' }, { snapshot_hash: 'forged' }]) {
    assert.equal((await fixture({ documents: [{ ...signedDocument(), ...patch }] }).run()).state, 'not_requested');
  }
});
test('paper is separately audited and does not fabricate a digital document', async () => {
  const attestation = { id: 5, paciente_id: 2, clinica_id: 72, tratamiento_id: null, purpose: 'data_protection',
    source: paper.PATIENT_PAPER_SOURCE, status: 'active', attested_by: 7, attested_at: now, revoked_at: null, revoked_by: null };
  const event = { id: 6, patient_id: 2, clinic_id: 72, actor_user_id: 7, event_type: paper.PAPER_EVENT,
    source: paper.PATIENT_PAPER_SOURCE, channel: 'internal', occurred_at: now, metadata: {
      schema_version: paper.PATIENT_PAPER_SOURCE, attestation_id: 5, appointment_id: null, clinic_template_id: 600,
      clinic_template_version_id: 700, catalog_key: privacy.FINAL_PRIVACY_KEY, source_document_sha256: digital.SOURCE_DOCUMENT_SHA256,
      legal_text_sha256: digital.LEGAL_TEXT_SHA256, acknowledged: true, recorded_at: now.toISOString(),
    } };
  const result = await fixture({ attestations: [attestation], events: [event] }).run();
  assert.equal(result.state, 'paper'); assert.equal(result.allowed, true); assert.equal(result.document_id, null);
  assert.equal(result.evidence.attestation_id, 5); assert.equal(result.has_pending, false);
});
test('missing publication is explicit and does not invent authorization', async () => {
  for (const data of [{ templates: [] }, { versions: [] }, { versions: [{ ...version, body_json: {} }] }]) {
    const result = await fixture(data).run(); assert.equal(result.configuration_error, true);
    assert.equal(result.allowed, false); assert.equal(result.attention_required, true);
  }
});
test('other clinics retain existing policy without reads', async () => {
  const f = fixture(), result = await f.run({ clinicId: 99 }); assert.equal(result.applicable, false); assert.equal(f.calls.length, 0);
  assert.equal(result.attention_required, false); assert.equal(result.required, false); assert.equal(result.allowed, true);
});
for (const clinicId of [66, 72]) {
  const localTemplate = { ...template, clinic_id: clinicId };
  const localPending = { ...structuredClone(pending), clinica_id: clinicId,
    snapshot_json: { ...structuredClone(pending.snapshot_json), template: localTemplate } };
  for (const [origin, evidence, reason] of [
    ['imported', { imported: [{ paciente_id: 2, value: '1075' }] }, 'existing_imported_patient'],
    ['prior care', { care: [{ paciente_id: 2, clinica_id: clinicId, first_care_id: 10, last_care_id: 10 }] }, 'existing_clinical_patient'],
  ]) {
    test(`${clinicId}: ${origin} missing/cancelled LOPD shows a reception action, not a fabricated request or care block`, async () => {
      for (const history of [{}, { documents: [{ ...localPending, status: 'cancelled' }] },
        { documents: [localPending], packages: [{ ...pkg, clinica_id: clinicId, status: 'cancelled' }] }]) {
        const result = await fixture({ templates: [localTemplate], packages: [{ ...pkg, clinica_id: clinicId }], ...evidence, ...history }).run({ clinicId });
        assert.equal(result.attention_required, true); assert.equal(result.required, false); assert.equal(result.allowed, true);
        assert.equal(result.reason, reason); assert.equal(result.state, 'not_requested'); assert.equal(result.has_pending, false);
        assert.equal(result.document_id, null); assert.equal(result.package_id, null); assert.equal(result.updated_at, null);
      }
    });
    test(`${clinicId}: ${origin} current pending/sent/viewed request stays actionable without losing the care exemption`, async () => {
      for (const requestState of ['pending', 'sent', 'viewed']) {
        const result = await fixture({ templates: [localTemplate], documents: [{ ...localPending, status: requestState }],
          packages: [{ ...pkg, clinica_id: clinicId }], ...evidence }).run({ clinicId });
        assert.equal(result.attention_required, true); assert.equal(result.has_pending, true); assert.equal(result.state, requestState);
        assert.equal(result.required, false); assert.equal(result.allowed, true); assert.equal(result.reason, reason);
      }
    });
    test(`${clinicId}: ${origin} valid signature or audited paper clears the reception action`, async () => {
      const signed = signedDocument(); signed.clinica_id = clinicId; signed.snapshot_json.template = localTemplate;
      signed.snapshot_hash = choices.choiceSnapshotHash(signed.snapshot_json, signed.snapshot_html);
      const signedResult = await fixture({ templates: [localTemplate], documents: [signed], ...evidence }).run({ clinicId });
      assert.equal(signedResult.state, 'signed'); assert.equal(signedResult.attention_required, false);
      assert.equal(signedResult.required, false); assert.equal(signedResult.allowed, true); assert.equal(signedResult.has_pending, false);
      const source = paper.PATIENT_PAPER_SOURCE;
      const attestation = { id: 5, paciente_id: 2, clinica_id: clinicId, tratamiento_id: null, purpose: 'data_protection',
        source, status: 'active', attested_by: 7, attested_at: now, revoked_at: null, revoked_by: null };
      const event = { id: 6, patient_id: 2, clinic_id: clinicId, actor_user_id: 7, event_type: paper.PAPER_EVENT,
        source, channel: 'internal', occurred_at: now, metadata: { schema_version: source, attestation_id: 5,
          appointment_id: null, clinic_template_id: 600, clinic_template_version_id: 700, catalog_key: privacy.FINAL_PRIVACY_KEY,
          source_document_sha256: digital.SOURCE_DOCUMENT_SHA256, legal_text_sha256: digital.LEGAL_TEXT_SHA256,
          acknowledged: true, recorded_at: now.toISOString() } };
      const paperResult = await fixture({ templates: [localTemplate], attestations: [attestation], events: [event], ...evidence }).run({ clinicId });
      assert.equal(paperResult.state, 'paper'); assert.equal(paperResult.attention_required, false);
      assert.equal(paperResult.required, false); assert.equal(paperResult.allowed, true); assert.equal(paperResult.has_pending, false);
    });
    test(`${clinicId}: ${origin} configuration failure remains visible but does not fabricate a new-patient care requirement`, async () => {
      const result = await fixture({ templates: [], ...evidence }).run({ clinicId });
      assert.equal(result.configuration_error, true); assert.equal(result.attention_required, true);
      assert.equal(result.required, false); assert.equal(result.allowed, true); assert.equal(result.reason, reason);
      assert.equal(result.state, 'not_requested'); assert.equal(result.has_pending, false); assert.equal(result.document_id, null);
    });
  }
}
test('missing LOPD actions for many imported/prior-care cards share one bounded context and never issue documents', async () => {
  for (const evidence of [{ imported: [{ paciente_id: 2, value: '1075' }] },
    { care: [{ paciente_id: 2, clinica_id: 72, first_care_id: 1, last_care_id: 1 }] }]) {
    const f = fixture(evidence), appointments = Array.from({ length: 200 }, (_, index) => ({ ...appointment, id_cita: index + 11 }));
    const context = await f.load(appointments), count = f.calls.length;
    for (const cita of appointments) {
      const result = status.privacyStateFromContext({ appointment: cita, context });
      assert.equal(result.attention_required, true); assert.equal(result.required, false); assert.equal(result.allowed, true);
      assert.equal(result.has_pending, false); assert.equal(result.document_id, null);
    }
    assert.equal(f.calls.length, count); assert(count <= 7); assert.equal(context.stateCache.size, 1);
  }
});
test('one bounded context serves eighty cards without any per-card queries', async () => {
  const f = fixture({ documents: [pending] }), appointments = Array.from({ length: 80 }, (_, index) => ({ ...appointment, id_cita: index + 11 }));
  const context = await f.load(appointments), count = f.calls.length;
  for (const cita of appointments) assert.equal(status.privacyStateFromContext({ appointment: cita, context }).state, 'pending');
  assert.equal(f.calls.length, count); assert(count <= 9); assert.equal(context.pairs.length, 1);
  assert.equal(context.stateCache.size, 1, 'legal validation also runs once per patient/clinic/prior-care category');
  assert.equal(f.calls.filter(([name]) => name === 'documents').length, 1);
});
test('evidence reads are patient/clinic scoped and do not request medical questionnaires', async () => {
  const f = fixture({ documents: [pending] }); await f.run();
  for (const [name, query] of f.calls) if (['documents', 'attestations'].includes(name)) {
    assert.deepEqual(query.where[Sequelize.Op.or], [{ paciente_id: 2, clinica_id: 72 }]);
    assert(!JSON.stringify(query).includes('answers'));
  }
});
function scopeFixture({ primary = 72, member = true, group = 29, targetGroup = 29, forgedMember = false } = {}) {
  const calls = [], transaction = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } };
  const db = { Sequelize, Paciente: { findByPk: async (id, query) => { calls.push(['patient', query]);
    return { id_paciente: 2, public_id: 'pac_qa', clinica_id: primary }; } },
    PacienteClinica: { findOne: async query => { calls.push(['membership', query]);
      return member ? { id: 3, paciente_id: forgedMember ? 99 : 2, clinica_id: 72 } : null; } },
    Clinica: { findByPk: async (id, query) => { calls.push(['clinic', query]);
      return { id_clinica: id, grupoClinicaId: id === primary ? group : targetGroup }; } } };
  return { calls, run: extra => status.patientForPrivacyClinic({ db, identifier: '2', clinicId: 72, transaction, ...extra }) };
}
test('read-only patient scope has no write locks; writes anchor patient and verified same-group membership', async () => {
  const read = scopeFixture({ primary: 66 }); assert.equal((await read.run()).id_paciente, 2);
  assert(read.calls.every(([, query]) => !query.lock));
  const write = scopeFixture({ primary: 66 }); await write.run({ lock: true });
  assert.equal(write.calls[0][1].lock, 'UPDATE'); assert.equal(write.calls[1][1].lock, 'SHARE');
  for (const data of [{ primary: 66, member: false }, { primary: 66, targetGroup: 30 },
    { primary: 66, group: null, targetGroup: null }, { primary: 66, forgedMember: true }]) {
    await assert.rejects(scopeFixture(data).run(), { code: 'patient_privacy_scope_forbidden', statusCode: 403 });
  }
});
const controllerSource = fs.readFileSync(require.resolve('../../controllers/patientPrivacy.controller'), 'utf8');
function controllerFixture() {
  const calls = [], module = { exports: {} }, transaction = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } };
  const db = { sequelize: { transaction: async (options, run) => { calls.push(['transaction', typeof options === 'function' ? {} : options]); return (run || options)(transaction); } },
    Clinica: { findByPk: async id => ({ id_clinica: id }) },
    CitaPaciente: { findByPk: async () => ({ id_cita: 11, paciente_id: 2, clinica_id: 72 }) } };
  vm.runInNewContext(controllerSource, { module, exports: module.exports, require(name) {
    if (name === '../../models') return db;
    if (name.includes('access-policy')) return { assertUserCanAccessFeature: async value => { calls.push(['acl', value]); } };
    if (name.includes('patientPrivacyStatus')) return { patientForPrivacyClinic: async value => { calls.push(['scope', value]); return { id_paciente: 2 }; },
      getPatientPrivacyStatus: async value => { calls.push(['status', value]); return { state: 'not_requested' }; } };
    if (name.includes('appointmentPrivacyEligibility')) return { CLINICS: [66, 72],
      registrationPolicy: async () => ({ enabled: true }) };
    if (name.includes('consentimientos.service')) return { createPatientIntakePackage: async (id, value) => { calls.push(['prepare', id, value]); return { created_count: 1 }; } };
    if (name.includes('registration-privacy-paper')) return { recordPatientRegistrationPrivacyPaper: async value => { calls.push(['paper', value]); return { created: true }; } };
    throw Error(name);
  } });
  return { calls, async run(action, changes = {}) {
    const req = { userData: { userId: 7 }, params: { id: 'pac_qa' }, query: { clinic_id: '72' }, body: { clinic_id: 72 }, ...changes };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await module.exports[action](req, res, error => { throw error; }); return res;
  } };
}
test('GET checks clinic ACL first, opens read-only snapshot and never issues a document', async () => {
  const f = controllerFixture(); assert.equal((await f.run('status')).code, 200);
  assert.equal(f.calls[0][1].readOnly, true); assert.equal(f.calls[1][0], 'acl'); assert.equal(f.calls[1][1].featureKey, 'consents.view');
  assert(!f.calls.some(([name]) => ['prepare', 'paper'].includes(name)));
});
test('preparation explicitly uses privacyOnly and server-resolved patient identity', async () => {
  const f = controllerFixture(); assert.equal((await f.run('prepare')).code, 201);
  const call = f.calls.find(([name]) => name === 'prepare'); assert.equal(call[1], 2); assert.equal(call[2].privacyOnly, true);
  assert.equal(call[2].clinicId, 72); assert.equal(call[2].createdBy, 7); assert.equal(call[2].allowLinkedClinic, true);
});
test('paper requires explicit acknowledgement and never invents an appointment', async () => {
  const f = controllerFixture(); assert.equal((await f.run('paper', { body: { clinic_id: 72, acknowledged: true } })).code, 201);
  const call = f.calls.find(([name]) => name === 'paper')[1]; assert.equal(call.patientId, 2); assert.equal(call.clinicId, 72);
  assert.equal(call.appointment, undefined); assert.equal(call.acknowledged, true);
  const missing = controllerFixture(); assert.equal((await missing.run('paper')).code, 400); assert.equal(missing.calls.length, 0);
});
test('arbitrary fields, malformed ids, arrays and conflicting clinics are rejected before document mutation', async () => {
  for (const [action, changes] of [['status', { query: { clinic_id: ['72'] } }], ['status', { query: { clinic_id: '72', appointment_id: '11oops' } }],
    ['prepare', { body: { clinic_id: 72, patientId: 99 } }], ['prepare', { body: { clinic_id: 72, clinica_id: 66 } }],
    ['paper', { body: { clinic_id: 72, acknowledged: true, appointmentId: 11 } }]]) {
    const f = controllerFixture(); assert.equal((await f.run(action, changes)).code, 400);
    assert(!f.calls.some(([name]) => ['prepare', 'paper', 'status'].includes(name)));
  }
});
