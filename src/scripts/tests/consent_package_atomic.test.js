'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const servicePath = path.resolve(__dirname, '../../services/consentimientos.service.js');

function harness() {
  const Op = require('sequelize').Op;
  const state = { packages: [], documents: [], calls: [], failDocument: null };
  const appointment = { id_cita: 1, paciente_id: 2, clinica_id: 3, tratamiento_id: 4,
    inicio: '2030-01-07T10:00:00Z', paciente: { id_paciente: 2, nombre: 'Ficticio' },
    clinica: { id_clinica: 3, nombre_clinica: 'Ficticia' }, tratamiento: { id_tratamiento: 4, nombre: 'Ficticio' },
    import_metadata: { notification_suppression: { day_before: true }, cliniccloud_reconciliation: { automation_policy: 'hold' } } };
  const requirements = [5, 6].map(id => ({ id, tratamiento_id: 4, clinic_template_id: id, required: true,
    blocking_policy: 'hard', clinicTemplate: { id, name: `Ficticio ${id}`, purpose: 'clinical', status: 'active',
      validity_mode: 'single_act', versions: [{ id: id + 10, version: 1, locale: 'es', status: 'published', title: 'Ficticio', body_html: '<p>Solo QA</p>' }] } }));
  const matches = (row, where = {}) => Reflect.ownKeys(where).every(key => {
    const value = where[key];
    if (value && typeof value === 'object') {
      if (value[Op.notIn]) return !value[Op.notIn].includes(row[key]);
      if (value[Op.in]) return value[Op.in].includes(row[key]);
    }
    return value === row[key];
  });
  let queue = Promise.resolve();
  const db = { Sequelize: { Op }, sequelize: { transaction: async (options, callback) => {
    assert.equal(options.isolationLevel, 'READ COMMITTED');
    let release;
    const previous = queue; queue = new Promise(resolve => { release = resolve; });
    await previous;
    const before = JSON.stringify({ packages: state.packages, documents: state.documents });
    const transaction = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } };
    try { return await callback(transaction); }
    catch (error) { Object.assign(state, JSON.parse(before)); throw error; }
    finally { release(); }
  } }, CitaPaciente: { findByPk: async (id, options) => {
    state.calls.push(['appointment', options]);
    return Number(id) === 1 ? appointment : null;
  } }, Paciente: {}, Clinica: {}, Tratamiento: {}, Usuario: {}, PatientIntakeRequest: { findOne: async () => null },
  ClinicConsentTemplate: {}, ClinicConsentTemplateVersion: { findOne: async options => {
    state.calls.push(['operational_version', options]);
    return requirements.find(row => row.clinic_template_id === options.where.clinic_template_id)?.clinicTemplate.versions
      .filter(row => row.status === options.where.status && row.locale === options.where.locale)
      .sort((a, b) => b.version - a.version || b.id - a.id)[0] || null;
  } }, ConsentTemplateCatalog: {}, ConsentTemplateCatalogVersion: {},
  TreatmentConsentRequirement: { findAll: async options => { state.calls.push(['requirements', options]); return requirements; } },
  ConsentSignaturePackage: {
    findOne: async options => state.packages.find(row => matches(row, options.where)) || null,
    create: async (values, options) => { state.calls.push(['package_create', options]); const row = { id: state.packages.length + 1, ...values }; state.packages.push(row); return row; },
    findByPk: async id => { const row = state.packages.find(item => item.id === id); return { ...row, documents: state.documents.filter(item => item.package_id === id) }; },
    update: async (values, options) => { state.calls.push(['package_update', options]); state.packages.filter(row => matches(row, options.where)).forEach(row => Object.assign(row, values)); },
  }, PatientConsentDocument: {
    findOne: async options => state.documents.find(row => matches(row, options.where)) || null,
    findAll: async options => state.documents.filter(row => matches(row, options.where)),
    create: async (values, options) => {
      state.calls.push(['document_create', options]);
      if (state.failDocument === values.clinic_template_id) throw Error('synthetic_document_failure');
      const row = { id: state.documents.length + 1, revoked_at: null, ...values }; state.documents.push(row); return row;
    },
  } };
  const nativeRequire = createRequire(servicePath), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(servicePath, 'utf8'), { require: name => name === '../../models' ? db : nativeRequire(name),
    module, exports: module.exports, __dirname: path.dirname(servicePath), process: { env: {} }, Buffer, console });
  return { db, state, appointment, requirements, prepare: () => module.exports.createPackageForAppointment(1, { createdBy: 7, triggerSource: 'synthetic' }) };
}

test('two preparations serialize on the appointment and reuse one complete package', async () => {
  const h = harness(), before = JSON.stringify(h.appointment);
  const [first, repeated] = await Promise.all([h.prepare(), h.prepare()]);
  assert.equal(first.id, repeated.id);
  assert.equal(h.state.packages.length, 1); assert.equal(h.state.documents.length, 2);
  assert.equal(repeated.required_count, 2); assert.equal(repeated.status, 'pending');
  const locks = h.state.calls.filter(([name, options]) => name === 'appointment' && options?.lock === 'UPDATE');
  assert.equal(locks.length, 2);
  for (const [name, options] of h.state.calls.filter(([name]) => name.endsWith('_create') || name.endsWith('_update'))) assert(options?.transaction, `${name} escaped transaction`);
  assert.equal(JSON.stringify(h.appointment), before);
});

test('a failure in the second document leaves neither a partial package nor the first document', async () => {
  const h = harness(); h.state.failDocument = 6;
  await assert.rejects(h.prepare(), /synthetic_document_failure/);
  assert.equal(h.state.packages.length, 0); assert.equal(h.state.documents.length, 0);
});

test('preparing again after signing preserves the original documents and signed state', async () => {
  const h = harness(); await h.prepare();
  h.state.documents.forEach(row => { row.status = 'signed'; row.signed_at = new Date(); });
  const hashes = h.state.documents.map(row => row.snapshot_hash);
  const result = await h.prepare();
  assert.equal(h.state.documents.length, 2);
  assert.deepEqual(h.state.documents.map(row => row.snapshot_hash), hashes);
  assert.equal(result.signed_count, 2); assert.equal(result.status, 'signed');
});

test('a revoked document can be prepared again without changing the revoked original', async () => {
  const h = harness(); await h.prepare();
  h.state.documents[0].status = 'revoked'; h.state.documents[0].revoked_at = new Date();
  const original = JSON.stringify(h.state.documents[0]);
  await h.prepare();
  assert.equal(h.state.documents.length, 3);
  assert.equal(JSON.stringify(h.state.documents[0]), original);
  await h.prepare();
  assert.equal(h.state.documents.length, 3, 'A later retry must find the replacement, not the revoked attempt');
  h.state.documents.slice(1).forEach(row => { row.status = 'signed'; row.signed_at = new Date(); });
  const final = await h.prepare();
  assert.equal(final.required_count, 2); assert.equal(final.signed_count, 2); assert.equal(final.status, 'signed');
  assert.equal(JSON.stringify(h.state.documents[0]), original);
});

test('an unavailable requirement version rolls back the entire package', async () => {
  const h = harness(); h.requirements[1].clinicTemplate.versions = [];
  await assert.rejects(h.prepare(), error => error.message === 'consent_template_version_unavailable' && error.statusCode === 409);
  assert.equal(h.state.packages.length, 0); assert.equal(h.state.documents.length, 0);
});

test('new documents select only the highest published Spanish version in the write transaction', async () => {
  const h = harness();
  h.requirements.forEach(row => row.clinicTemplate.versions.push(
    { id: 100 + row.id, version: 2, status: 'draft', locale: 'es', title: 'Borrador', body_html: '<p>Borrador</p>' },
    { id: 200 + row.id, version: 3, status: 'archived', locale: 'es', title: 'Archivado', body_html: '<p>Archivado</p>' },
    { id: 300 + row.id, version: 4, status: 'published', locale: 'en', title: 'Otro idioma', body_html: '<p>Other</p>' },
    { id: 400 + row.id, version: 5, status: 'published', locale: 'es', title: 'Publicado español', body_html: '<p>Publicado</p>' },
  ));
  await h.prepare();
  assert.deepEqual(h.state.documents.map(row => row.clinic_template_version_id), [405, 406]);
  const calls = h.state.calls.filter(([name]) => name === 'operational_version');
  assert.equal(calls.length, 2);
  calls.forEach(([, options]) => {
    assert(options.transaction); assert.equal(options.where.status, 'published'); assert.equal(options.where.locale, 'es');
    assert.equal(options.lock, options.transaction.LOCK.SHARE);
    assert.deepEqual(Array.from(options.order, item => Array.from(item)), [['version', 'DESC'], ['id', 'DESC']]);
  });
});

test('only a draft or a foreign published version cannot issue a new Spanish document', async () => {
  for (const version of [
    { status: 'draft', locale: 'es' }, { status: 'published', locale: 'en' }, { status: 'archived', locale: 'es' },
  ]) {
    const h = harness(); Object.assign(h.requirements[1].clinicTemplate.versions[0], version);
    await assert.rejects(h.prepare(), error => error.message === 'consent_template_version_unavailable' && error.statusCode === 409);
    assert.equal(h.state.packages.length, 0); assert.equal(h.state.documents.length, 0);
  }
});

test('same-act frozen documents do not require a current published version or perform another issuance query', async () => {
  const h = harness(); await h.prepare();
  const frozen = JSON.stringify(h.state.documents);
  const queried = h.state.calls.filter(([name]) => name === 'operational_version').length;
  h.requirements.forEach(row => row.clinicTemplate.versions = []);
  await h.prepare();
  assert.equal(JSON.stringify(h.state.documents), frozen);
  assert.equal(h.state.calls.filter(([name]) => name === 'operational_version').length, queried);
});

test('patient signature pending professional signature is retained, not replaced by a blank document', async () => {
  const h = harness(); await h.prepare();
  const doc = h.state.documents[0]; doc.status = 'signed'; doc.signed_at = new Date();
  doc.snapshot_json.template.requires_professional_signature = true;
  const original = JSON.stringify(doc);
  await h.prepare();
  assert.equal(h.state.documents.length, 2); assert.equal(JSON.stringify(doc), original);
});

test('actual package preparation resolves a linked ClinicCloud unit and its booked professional canonically', async () => {
  const h = harness();
  Object.assign(h.appointment, { source_system: 'cliniccloud', voucher_id: 8, doctor_id: 99,
    doctor: { id_usuario: 99, nombre: 'No corresponde a estas fases' } });
  h.appointment.import_metadata.program_session = { session_id: '15', key: 's1' };
  h.appointment.import_metadata.booking = { phases: [{ key: 'original-care', doctor_ids: [7] }] };
  const calls = [];
  h.db.PatientVoucher = { findOne: async options => {
    calls.push(['voucher', options]);
    assert.equal(options.where.id, 8); assert.equal(options.where.patient_id, 2);
    assert.equal(options.where.clinic_id, 3); assert.equal(options.where.source_system, 'treatment_program');
    return { id: 8 };
  } };
  h.db.PatientProgramSession = { findOne: async options => {
    calls.push(['session', options]);
    assert.equal(options.where.voucher_id, 8); assert.equal(options.where.appointment_id, 1);
    return { id: 15, snapshot: { treatment_ids: [4], linked_appointment: { id: 1 } } };
  } };
  h.db.Usuario.findAll = async options => {
    calls.push(['professional', options]);
    assert.deepEqual(Array.from(options.where.id_usuario[require('sequelize').Op.in]), [7]);
    return [{ id_usuario: 7, nombre: 'Profesional de la reserva' }];
  };
  const before = JSON.stringify(h.appointment);
  await h.prepare();
  assert(calls.filter(([name]) => name === 'session').length >= 2, 'requirements and professional context use the ledger');
  assert(calls.every(([, options]) => options.transaction));
  assert.equal(h.state.documents.length, 2);
  h.state.documents.forEach(document => {
    assert.equal(document.snapshot_json.context.profesional.id, 7);
    assert.equal(document.snapshot_json.context.profesional.nombre, 'Profesional de la reserva');
    assert.doesNotMatch(JSON.stringify(document.snapshot_json.context), /No corresponde/);
  });
  assert.equal(JSON.stringify(h.appointment), before);
});

test('linked-source packages fail closed before producing documents if canonical purchase ownership is missing', async () => {
  const h = harness();
  Object.assign(h.appointment, { source_system: 'cliniccloud', voucher_id: 8 });
  h.appointment.import_metadata.program_session = { session_id: '15', key: 's1', treatment_ids: [4] };
  h.db.PatientVoucher = { findOne: async () => null };
  await assert.rejects(h.prepare(), { code: 'program_session_not_found' });
  assert.equal(h.state.packages.length, 0); assert.equal(h.state.documents.length, 0);
});
