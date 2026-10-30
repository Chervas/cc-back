'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
// This suite never imports application configuration, connects to MySQL, or uses providers.
const forbidden = () => { throw Error('LEAD_PATIENT_CONTEXT_OFFLINE_ONLY'); };
require('node:net').Socket.prototype.connect = forbidden;
require('node:tls').connect = forbidden;
global.fetch = forbidden;
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if ([path.resolve(__dirname, '../../../models/index.js'), path.resolve(__dirname, '../../app.js')].includes(resolved)) forbidden();
  return originalLoad.call(this, request, parent, isMain);
};
const { Op, Sequelize, DataTypes } = require('sequelize');
const { createLeadPatientContextService, enrich: enrichWrapper } = require('../../services/leadPatientContext.service');
const { LEAD_PATIENT_CONTEXT_TYPE: KEY, LEAD_PATIENT_ATTENTION_TYPE: ATTENTION,
  leadPatientContextSql, normalizeContextPhone, readContextSnapshot, namesConflict } = require('../../lib/lead-patient-context');

const ENTRY = '2026-08-10T12:00:00.000Z';
const OLD = '2026-07-01T12:00:00.000Z';
const LATER = '2026-08-11T12:00:00.000Z';
const lead = (patch = {}) => ({ id: 1, clinica_id: 10, grupo_clinica_id: 5, created_at: ENTRY,
  telefono: '+34 612 345 678', email: 'ana@example.test', nombre: 'Ana Pérez', status_lead: 'nuevo', archived_at: null, ...patch });
const patient = (patch = {}) => ({ id_paciente: 20, clinica_id: 10, telefono_movil: '612345678',
  telefono_secundario: null, email: 'ana@example.test', nombre: 'Ana', apellidos: 'Pérez',
  createdAt: OLD, clinicasVinculadas: [], ...patch });
const appointment = (patch = {}) => ({ id_cita: 40, paciente_id: 20, clinica_id: 10,
  lead_intake_id: null, estado: 'ha_acudido', inicio: OLD, arrived_at: OLD,
  care_started_at: null, care_completed_at: null, created_at: OLD, updated_at: OLD, ...patch });
const snapshot = (patch = {}) => ({ version: 1, relationship: 'new_contact', patient_id: null,
  clinic_id: null, clinic_name: null, same_clinic: null, captured_at: ENTRY, reason: 'no_prior_patient_at_entry',
  request_kind: 'commercial', ...patch });
function fixture(input = {}) {
  const state = { leads: [lead()], patients: [], clinics: [
    { id_clinica: 10, grupoClinicaId: 5, nombre_clinica: 'Centro' },
    { id_clinica: 11, grupoClinicaId: 5, nombre_clinica: 'Norte' },
    { id_clinica: 99, grupoClinicaId: 9, nombre_clinica: 'Ajena' },
  ], relations: [], appointments: [], conversations: [], audits: [], ...input };
  const calls = [];
  let serial = Promise.resolve();
  const tx = new (class FixtureTransaction { constructor() { this.LOCK = { UPDATE: 'UPDATE' }; } })();
  const logger = { warn: (...args) => calls.push(['warn', args]) };
  const db = {
    sequelize: { transaction: async callback => {
      const previous = serial; let release; serial = new Promise(resolve => { release = resolve; });
      await previous;
      const count = state.audits.length;
      try { return await callback(tx); } catch (error) { state.audits.splice(count); throw error; } finally { release(); }
    } },
    LeadIntake: {
      findByPk: async (id, options) => { calls.push(['lead.lock', options]); return state.leads.find(row => row.id === id); },
      findAll: async options => { calls.push(['leads', options]); return state.leads.filter(row => options.where.id[Op.in].includes(row.id)
        && (!options.where.status_lead || options.where.status_lead[Op.in].includes(row.status_lead) && !row.archived_at)); },
    },
    LeadAttributionAudit: {
      findAll: async options => { calls.push(['audits', options]); return state.audits
        .filter(row => options.where.lead_intake_id[Op.in].includes(row.lead_intake_id)).sort((a, b) => a.id - b.id); },
      create: async (values, options) => { calls.push(['audit.create', options]);
        if (state.auditFailure) throw Error('fixture_audit_failure');
        const row = { id: state.audits.length + 1, ...structuredClone(values) }; state.audits.push(row); return row; },
    },
    Clinica: { findAll: async options => { calls.push(['clinics', options]); if (state.classificationFailure) throw state.classificationFailure;
      const clauses = options.where[Op.or] || [options.where];
      return state.clinics.filter(row => clauses.some(clause => clause.id_clinica?.[Op.in]?.includes(row.id_clinica)
        || clause.grupoClinicaId?.[Op.in]?.includes(row.grupoClinicaId))); } },
    Paciente: { findAll: async options => { calls.push(['patients', options]); return state.patients; } },
    PacienteClinica: {},
    PacienteRelacion: { findAll: async options => { calls.push(['relations', options]); return state.relations; } },
    CitaPaciente: { findAll: async options => { calls.push(['appointments', options]); return state.appointments; } },
    Conversation: { findAll: async options => { calls.push(['conversations', options]); return state.conversations; } },
  };
  return { state, calls, db, tx, logger, service: createLeadPatientContextService(db, { logger }) };
}
const audit = (value, id = 1, leadId = 1) => ({ id, lead_intake_id: leadId,
  attribution_steps: { type: KEY, [KEY]: value } });

test('birth snapshot is immutable after this acquisition creates a patient and appointment', async () => {
  const f = fixture();
  const initial = await f.service.capture(lead(), { atCreation: true });
  assert.equal(initial.relationship, 'new_contact'); assert.equal(initial.persisted, true);
  assert.equal(f.state.audits[0].attribution_steps.type, KEY);
  assert.equal(f.state.audits[0].attribution_steps[KEY].version, 1);
  assert.equal(f.state.audits[0].raw_payload, null);
  f.state.patients.push(patient({ createdAt: LATER }));
  f.state.appointments.push(appointment({ lead_intake_id: 1, inicio: LATER, arrived_at: LATER }));
  assert.deepEqual(await f.service.get(lead()), initial);
  assert.deepEqual(await f.service.capture(lead()), initial);
  assert.equal(f.state.audits.length, 1);
});

test('capture serializes on parent and forwards the supplied transaction to every query', async () => {
  const f = fixture({ patients: [patient()] });
  const result = await f.service.capture(lead(), { transaction: f.tx, atCreation: true });
  assert.equal(result.relationship, 'existing_patient'); assert.equal(result.patient_id, 20);
  assert.equal(result.same_clinic, true); assert.equal(result.clinic_name, 'Centro');
  assert.equal(f.calls[0][0], 'lead.lock'); assert.equal(f.calls[0][1].lock, 'UPDATE');
  for (const [name, options] of f.calls) if (name !== 'warn') assert.equal(options.transaction, f.tx, name);
  const concurrent = fixture();
  const values = await Promise.all(Array.from({ length: 8 }, () => concurrent.service.capture(lead(), { atCreation: true })));
  assert.equal(concurrent.state.audits.length, 1);
  values.forEach(value => assert.deepEqual(value, values[0]));
});

test('legacy reads do not write or turn absence of evidence into a new contact', async () => {
  const f = fixture();
  const missing = await f.service.get(lead());
  assert.equal(missing.relationship, 'unknown'); assert.equal(missing.persisted, false); assert.equal(missing.captured_at, null);
  f.state.patients.push(patient());
  assert.equal((await f.service.get(lead())).relationship, 'possible_patient');
  f.state.appointments.push(appointment());
  const existing = await f.service.get(lead());
  assert.equal(existing.relationship, 'existing_patient'); assert.equal(existing.persisted, false);
  assert.equal(existing.reason, 'prior_attendance'); assert.equal(f.state.audits.length, 0);
  const frozen = await f.service.capture(lead(), { transaction: f.tx });
  assert.equal(frozen.relationship, 'existing_patient'); assert.equal(frozen.persisted, true);
  f.state.appointments.length = 0;
  assert.deepEqual(await f.service.get(lead()), frozen);
});

test('technical record from the same acquisition and same-second timestamps do not establish a prior patient', async () => {
  for (const createdAt of [ENTRY, '2026-08-10T12:00:00.001Z', LATER]) {
    const f = fixture({ patients: [patient({ createdAt })], appointments: [appointment({ lead_intake_id: 1 })] });
    assert.equal((await f.service.capture(lead(), { atCreation: true })).relationship, 'new_contact');
  }
});

test('open earlier acquisition without attendance is possible, whether linked by appointment or conversation', async () => {
  for (const source of ['appointment', 'conversation']) {
    const f = fixture({ patients: [patient()], leads: [lead(), lead({ id: 2, created_at: OLD })],
      appointments: source === 'appointment' ? [appointment({ lead_intake_id: 2, estado: 'pendiente', arrived_at: null })] : [],
      conversations: source === 'conversation' ? [{ patient_id: 20, lead_id: 2, clinic_id: 10 }] : [] });
    const context = await f.service.capture(lead(), { atCreation: true });
    assert.equal(context.relationship, 'possible_patient'); assert.equal(context.reason, 'open_acquisition_record');
    assert.equal(context.patient_id, null);
    const confirmed = fixture({ ...f.state, audits: [], appointments: [appointment()] });
    assert.equal((await confirmed.service.capture(lead(), { atCreation: true })).relationship, 'existing_patient');
  }
});

test('shared phones, guardian relations, conflicting names and contact contradictions never expose a patient identity', async () => {
  const cases = [
    { patients: [patient(), patient({ id_paciente: 21 })], reason: 'ambiguous_contact' },
    { patients: [patient()], relations: [{ id_paciente: 20, id_paciente_relacionado: 21, fecha_inicio: OLD }], reason: 'shared_contact' },
    { patients: [patient({ nombre: 'Luis' })], reason: 'conflicting_name' },
    { patients: [patient({ email: 'other@example.test' })], reason: 'conflicting_contact' },
    { patients: [patient({ telefono_movil: null, telefono_secundario: '612345678' })], reason: 'secondary_contact' },
  ];
  for (const input of cases) {
    const f = fixture(input);
    const context = await f.service.capture(lead(), { atCreation: true });
    assert.equal(context.relationship, 'possible_patient', input.reason);
    assert.equal(context.reason, input.reason); assert.equal(context.patient_id, null);
    assert.equal(context.clinic_id, null); assert.equal(context.clinic_name, null);
  }
  assert.equal(namesConflict('Ana Perez', patient()), false);
  assert.equal(namesConflict('Ana', patient()), false);
});

test('scope includes group patients and prior links but never other tenants or new links', async () => {
  const sibling = fixture({ patients: [patient({ clinica_id: 11 })] });
  assert.deepEqual((({ relationship, clinic_id, same_clinic }) => ({ relationship, clinic_id, same_clinic }))(
    await sibling.service.capture(lead(), { atCreation: true })), { relationship: 'existing_patient', clinic_id: 11, same_clinic: false });
  const other = fixture({ patients: [patient({ clinica_id: 99 })] });
  assert.equal((await other.service.capture(lead(), { atCreation: true })).relationship, 'new_contact');
  for (const createdAt of [OLD, LATER]) {
    const linked = fixture({ patients: [patient({ clinica_id: 99, clinicasVinculadas: [{ clinica_id: 10, createdAt }] })] });
    assert.equal((await linked.service.capture(lead(), { atCreation: true })).relationship,
      createdAt === OLD ? 'existing_patient' : 'new_contact');
  }
  const badScope = fixture({ leads: [lead({ grupo_clinica_id: 9 })], patients: [patient()] });
  assert.equal((await badScope.service.capture(lead(), { atCreation: true })).reason, 'scope_unavailable');
});

test('full phone normalization retains country codes and rejects multi-number input', async () => {
  assert.equal(normalizeContextPhone('0034 (612) 345-678'), '34612345678');
  assert.equal(normalizeContextPhone('+1 612345678'), '1612345678');
  assert.equal(normalizeContextPhone('612345678 / 699999999'), null);
  const f = fixture({ patients: [patient({ telefono_movil: '+1612345678', email: null })] });
  assert.equal((await f.service.capture(lead({ email: null }), { atCreation: true })).relationship, 'new_contact');
});

test('future/pending attendance and attendance for this lead are not prior evidence', async () => {
  for (const patch of [{ estado: 'pendiente' }, { inicio: LATER, arrived_at: LATER }, { lead_intake_id: 1 },
    { arrived_at: null, updated_at: LATER }, { arrived_at: LATER }]) {
    const f = fixture({ patients: [patient()], appointments: [appointment(patch)] });
    assert.equal((await f.service.get(lead())).relationship, 'possible_patient', JSON.stringify(patch));
  }
});

test('classification failures persist unknown and log only a fixed code; audit failures propagate', async () => {
  const error = Object.assign(Error('patient SECRET email@example.test SQL password'), { original: { code: 'ER_NO_SUCH_TABLE' } });
  const f = fixture({ classificationFailure: error });
  const context = await f.service.capture(lead(), { atCreation: true });
  assert.equal(context.relationship, 'unknown'); assert.equal(context.reason, 'classification_failed');
  assert.equal(context.persisted, true); assert.equal(f.state.audits.length, 1);
  assert.deepEqual(f.calls.find(row => row[0] === 'warn')[1], ['lead_patient_context_classification_failed', { code: 'ER_NO_SUCH_TABLE' }]);
  assert.doesNotMatch(JSON.stringify(f.state.audits), /SECRET|email@example/);
  const failedWrite = fixture({ auditFailure: true });
  await assert.rejects(failedWrite.service.capture(lead(), { atCreation: true }), /fixture_audit_failure/);
  assert.equal(failedWrite.state.audits.length, 0);
});

test('latest valid attention overlays the DTO without changing the first immutable snapshot', async () => {
  const f = fixture({ audits: [audit(snapshot())] });
  const decide = (id, value) => f.state.audits.push({ id, lead_intake_id: 1, attribution_steps: { type: ATTENTION, [ATTENTION]: {
    version: 1, decision: 'director', request_kind: 'patient_care', clinic_id: 10, ...value } } });
  decide(2, {}); decide(3, { version: 2, request_kind: 'commercial' }); decide(4, { clinic_id: 99, request_kind: 'commercial' });
  const first = structuredClone(f.state.audits[0]);
  const got = await f.service.get(lead());
  assert.equal(got.request_kind, 'patient_care'); assert.equal(got.relationship, 'new_contact');
  assert.deepEqual(await f.service.capture(lead()), got); assert.deepEqual(f.state.audits[0], first);
  decide(5, { decision: 'clinic', request_kind: 'commercial' });
  assert.equal((await f.service.get(lead())).request_kind, 'commercial');
});

test('unrelated audits never count and malformed first snapshots cannot be silently replaced', async () => {
  const f = fixture({ audits: [
    { id: 1, lead_intake_id: 1, attribution_steps: { action: 'status_update', [KEY]: snapshot() } },
    audit({ version: 2 }, 2), audit(snapshot(), 3),
  ] });
  assert.equal((await f.service.get(lead())).reason, 'snapshot_invalid');
  assert.equal((await f.service.capture(lead())).reason, 'snapshot_invalid');
  assert.equal(f.state.audits.length, 3);
  assert.equal(readContextSnapshot(snapshot({ relationship: 'existing_patient' })), null);
});

test('foreign or untyped attention payloads cannot override a typed decision or snapshot', async () => {
  const attention = { version: 1, decision: 'director', request_kind: 'patient_care', clinic_id: 10 };
  for (const type of [undefined, null, 'status_update', KEY]) {
    const f = fixture({ audits: [audit(snapshot()), { id: 2, lead_intake_id: 1,
      attribution_steps: { ...(type !== undefined ? { type } : {}), [ATTENTION]: attention } }] });
    assert.equal((await f.service.get(lead())).request_kind, 'commercial', String(type));
    assert.equal((await f.service.capture(lead())).request_kind, 'commercial', String(type));
    assert.equal(f.state.audits.length, 2);
  }
  const f = fixture({ audits: [audit(snapshot()), { id: 2, lead_intake_id: 1,
    attribution_steps: { type: ATTENTION, [ATTENTION]: attention } }, { id: 3, lead_intake_id: 1,
    attribution_steps: { type: 'status_update', [ATTENTION]: { ...attention, request_kind: 'commercial' } } }] });
  assert.equal((await f.service.get(lead())).request_kind, 'patient_care');
  const query = f.calls.find(row => row[0] === 'audits')[1];
  assert.equal(query.where[Op.or], undefined);
  assert.equal(query.where[Op.and][0].attribute.path, 'attribution_steps.type');
  assert.deepEqual(query.where[Op.and][0].logic[Op.in], [KEY, ATTENTION]);
});

test('legacy enrichment batches all evidence, preserves inputs and can hydrate minimal conversation lead projections', async () => {
  const leads = Array.from({ length: 60 }, (_, index) => lead({ id: index + 1 }));
  const f = fixture({ leads, patients: [patient()], appointments: [appointment()] });
  const input = leads.map(row => ({ id: row.id }));
  const output = await enrichWrapper(input, { db: f.db });
  assert.equal(output.length, 60); assert.equal(input[0].patient_context, undefined);
  assert.ok(output.every(row => row.patient_context.relationship === 'existing_patient' && !row.patient_context.persisted));
  for (const name of ['audits', 'leads', 'patients', 'relations', 'appointments', 'conversations']) {
    assert.equal(f.calls.filter(row => row[0] === name).length, 1, name);
  }
  assert.equal(f.state.audits.length, 0);
  const auditOptions = f.calls.find(row => row[0] === 'audits')[1];
  assert.ok(!auditOptions.attributes.includes('raw_payload')); assert.ok(!auditOptions.attributes.includes('attribution_steps'));
});

test('bounded searches classify conservatively instead of choosing an arbitrary candidate', async () => {
  const f = fixture({ patients: Array.from({ length: 501 }, (_, index) => patient({ id_paciente: index + 1 })) });
  const context = await f.service.capture(lead(), { atCreation: true });
  assert.equal(context.relationship, 'possible_patient'); assert.equal(context.reason, 'candidate_limit');
});

test('a capture performed by a later decision freezes unknown, never invents a birth snapshot', async () => {
  const f = fixture();
  const context = await f.service.capture(lead(), { transaction: f.tx });
  assert.equal(context.relationship, 'unknown'); assert.equal(context.persisted, true);
  assert.equal(context.reason, 'no_prior_evidence');
  f.state.patients.push(patient());
  f.state.appointments.push(appointment());
  assert.deepEqual(await f.service.get(lead()), context);
});

test('incomplete model fixtures produce a healthy unknown audit with a code-only warning', async () => {
  const f = fixture();
  delete f.db.Clinica;
  const context = await f.service.capture(lead(), { atCreation: true });
  assert.equal(context.relationship, 'unknown'); assert.equal(context.persisted, true);
  assert.equal(f.state.audits[0].attribution_steps[KEY].reason, 'classification_failed');
  assert.deepEqual(f.calls.find(row => row[0] === 'warn')[1], ['lead_patient_context_classification_failed', { code: 'classification_error' }]);
});

test('SQL expressions are alias-safe, immutable-first, decision-last and build without any DB connection', async () => {
  const expressions = leadPatientContextSql({ leadAlias: 'lead' });
  for (const alias of ['lead;DROP TABLE X', 'lead.id', '`lead`', '', 'lead x', 'x'.repeat(65)]) {
    assert.throws(() => leadPatientContextSql({ leadAlias: alias }), /invalid_lead_alias/);
  }
  assert.match(expressions.snapshot, /ORDER BY `lpc_snapshot`.`id` ASC LIMIT 1/);
  assert.match(expressions.attention_kind, /ORDER BY `lpc_attention`.`id` DESC LIMIT 1/);
  assert.ok(expressions.attention_kind.includes("JSON_UNQUOTE(JSON_EXTRACT(`lpc_attention`.`attribution_steps`, '$.type')) = 'lead_patient_attention_v1'"));
  assert.match(expressions.request_kind, /`lead`.`clinica_id`/);
  assert.match(expressions.relationship, /ELSE 'unknown'/);
  assert.doesNotMatch(Object.values(expressions).join(' '), /raw_payload|telefono|patient_match/);
  const sequelize = new Sequelize('offline', 'offline', 'offline', { dialect: 'mysql', logging: false });
  const query = sequelize.getQueryInterface().queryGenerator.selectQuery('LeadIntakes', {
    attributes: ['id', [sequelize.literal(expressions.relationship), 'relationship']], tableAs: 'lead',
  });
  assert.match(query, /FROM `LeadIntakes` AS `lead`/);
  await sequelize.close();
});

function hookFixture() {
  const sequelize = new Sequelize('offline', 'offline', 'offline', { dialect: 'mysql', logging: false });
  const Lead = require('../../../models/leadintake')(sequelize, DataTypes);
  const Audit = require('../../../models/leadattributionaudit')(sequelize, DataTypes);
  const f = fixture();
  const inserted = [];
  // Exercise Sequelize's real create/save -> afterCreate dispatch with an in-memory insert adapter.
  sequelize.getQueryInterface().insert = async instance => {
    instance.set('id', 1); inserted.push(instance); return [instance, 1];
  };
  // Simulate transaction visibility/rollback without opening any database connection.
  sequelize.transaction = async callback => {
    const count = inserted.length;
    try { return await f.db.sequelize.transaction(callback); }
    catch (error) { inserted.splice(count); throw error; }
  };
  Lead.findByPk = f.db.LeadIntake.findByPk;
  Audit.findAll = f.db.LeadAttributionAudit.findAll;
  Audit.create = f.db.LeadAttributionAudit.create;
  for (const name of ['Clinica', 'Paciente', 'PacienteClinica', 'PacienteRelacion', 'CitaPaciente', 'Conversation']) sequelize.models[name] = f.db[name];
  return { ...f, sequelize, Lead, Audit, inserted };
}

test('real Sequelize afterCreate hook uses registered models and caller transaction, with no application boot', async () => {
  const f = hookFixture();
  const { sequelize, Lead } = f;
  await Lead.create(lead(), { transaction: f.tx });
  assert.equal(f.state.audits.length, 1); assert.equal(f.state.audits[0].attribution_steps[KEY].relationship, 'new_contact');
  assert.equal(f.calls.find(row => row[0] === 'audit.create')[1].transaction, f.tx);
  await Lead.create(lead(), { transaction: f.tx, hooks: false });
  assert.equal(f.state.audits.length, 1);
  await sequelize.close();
});

test('nontransactional reception survives audit failure with transient unknown, sanitized logging and no automatic retry', async t => {
  const f = hookFixture();
  t.after(() => f.sequelize.close());
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  let attempts = 0;
  f.Audit.create = async () => {
    attempts++;
    throw Object.assign(Error('sensitive patient text and SQL'), { original: { code: 'ER_BAD_FIELD_ERROR' } });
  };
  const created = await f.Lead.create(lead());
  assert.equal(created.isNewRecord, false);
  assert.equal(f.inserted.length, 1);
  assert.equal(attempts, 1);
  assert.equal(f.state.audits.length, 0);
  assert.deepEqual(created.toJSON().patient_context, {
    relationship: 'unknown', patient_id: null, clinic_id: null, clinic_name: null, same_clinic: null,
    captured_at: null, reason: 'snapshot_capture_failed', request_kind: 'commercial', persisted: false,
  });
  assert.deepEqual(warnings, [['lead_patient_context_capture_failed', { code: 'ER_BAD_FIELD_ERROR' }]]);
  // Recovery is an explicit later write; it must not invent a new-contact birth fact.
  const recovered = await f.service.capture(created);
  assert.equal(recovered.persisted, true);
  assert.equal(recovered.relationship, 'unknown');
  assert.equal(f.state.audits.length, 1);
  assert.deepEqual(await f.service.capture(created), recovered);
  assert.equal(f.state.audits.length, 1);
  assert.equal(f.inserted.length, 1);
});

test('caller transaction receives the original audit failure and can roll back the lead', async t => {
  const f = hookFixture();
  t.after(() => f.sequelize.close());
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const failure = Error('fixture_transaction_audit_failure');
  let attempts = 0;
  f.Audit.create = async () => { attempts++; throw failure; };
  await assert.rejects(f.sequelize.transaction(transaction => f.Lead.create(lead(), { transaction })),
    error => error === failure);
  assert.equal(f.inserted.length, 0);
  assert.equal(f.state.audits.length, 0);
  assert.equal(attempts, 1);
  assert.deepEqual(warnings, []);
});

test('missing audit models and failing logger do not invalidate nontransactional reception', async t => {
  const f = hookFixture();
  t.after(() => f.sequelize.close());
  delete f.sequelize.models.LeadAttributionAudit;
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => { warnings.push(args); throw Error('fixture_logger_failed'); });
  const created = await f.Lead.create(lead());
  assert.equal(f.inserted.length, 1);
  assert.equal(created.toJSON().patient_context.persisted, false);
  assert.equal(created.toJSON().patient_context.relationship, 'unknown');
  assert.equal(f.state.audits.length, 0);
  assert.deepEqual(warnings, [['lead_patient_context_capture_failed', { code: 'capture_error' }]]);
});
