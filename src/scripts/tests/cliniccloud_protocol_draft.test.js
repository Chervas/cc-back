'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const command = require('../../lib/cliniccloud-import/protocol-draft');
const { createTreatmentDocumentationService } = require('../../services/treatmentDocumentation.service');
const migration = require('../../../migrations/20260907020000-allow-system-import-protocol-actors');
const bytes = Buffer.from('BS MEDICAL\nAPARATOLOGÍA CORPORAL\npendiente de validación médica\nTexto fuente intacto.\n');

function harness() {
  let rows = [], revisions = [], next = 1;
  const events = [], journals = [];
  const options = { group: 29, failRevision: false, failJournal: false, failCommitJournal: false };
  const row = values => ({ ...values, toJSON() { const { toJSON, ...plain } = this; return plain; } });
  const db = { Sequelize: { Op: { or: Symbol('or'), like: Symbol('like') } },
    Clinica: { findOne: async () => ({ id_clinica: 72, grupoClinicaId: options.group }) },
    Tratamiento: { findAll: async () => [] },
    TreatmentProtocol: {
      findOne: async () => rows[0] || null,
      findAll: async () => rows,
      create: async (values, { transaction }) => { events.push(['protocol', transaction]); const created = row({ ...values, id: next++ }); rows.push(created); return created; },
    },
    TreatmentProtocolRevision: { create: async (values, { transaction }) => { events.push(['revision', transaction]); if (options.failRevision) throw new Error('REVISION_FAILED'); revisions.push(values); } },
    sequelize: { transaction: async callback => {
      const before = [...rows], beforeRevisions = [...revisions];
      const transaction = { LOCK: { UPDATE: 'UPDATE' } }; events.push(['begin', transaction]);
      try { const result = await callback(transaction); events.push(['commit', transaction]); return result; }
      catch (error) { rows = before; revisions = beforeRevisions; events.push(['rollback', transaction]); throw error; }
    } },
  };
  const service = createTreatmentDocumentationService(db);
  const journal = { before: value => { events.push(['before']); journals.push(value); }, written: value => { events.push(['written']); if (options.failJournal) throw new Error('JOURNAL_FAILED'); journals.push(value); }, committed: value => { if (options.failCommitJournal) throw new Error('COMMIT_JOURNAL_FAILED'); journals.push(value); } };
  const plan = command.buildProtocolDraftPlan({ sourceBytes: bytes });
  const execute = () => command.applyProtocolDraftPlan({ db, service, plan, sourceBytes: bytes, approvedHash: plan.plan_sha256, journal });
  return { db, service, options, events, journals, plan, execute, rows: () => rows, revisions: () => revisions };
}

test('plan preserves supplied document and never infers associations or approval', () => {
  const plan = command.buildProtocolDraftPlan({ sourceBytes: bytes });
  assert.equal(plan.payload.content, bytes.toString().trim());
  assert.equal(plan.payload.status, 'draft'); assert.deepEqual(plan.payload.treatment_ids, []);
  assert.match(plan.payload.source, /actor_kind=system_import/);
  assert.equal(command.validatePlan(plan, bytes, plan.plan_sha256).plan_sha256, plan.plan_sha256);
  assert.throws(() => command.validatePlan({ ...plan, clinic_id: 66 }, bytes, plan.plan_sha256), { code: 'PROTOCOL_PLAN_HASH_MISMATCH' });
  assert.throws(() => command.validatePlan(plan, Buffer.concat([bytes, Buffer.from('Cambio')]), plan.plan_sha256), { code: 'PROTOCOL_PLAN_SOURCE_MISMATCH' });
});

test('canonical save participates in one transaction, persists one revision and technical null actors', async () => {
  const h = harness(); const result = await h.execute();
  assert.equal(result.action, 'created_draft'); assert.equal(result.associations_created, 0);
  assert.equal(h.rows().length, 1); assert.equal(h.revisions().length, 1);
  assert.equal(h.rows()[0].created_by, null); assert.equal(h.revisions()[0].actor_id, null);
  assert.deepEqual(h.events.map(event => event[0]), ['begin', 'before', 'protocol', 'revision', 'written', 'commit']);
  const transaction = h.events[0][1];
  assert(h.events.filter(event => ['protocol', 'revision'].includes(event[0])).every(event => event[1] === transaction));
});

test('replay after success never creates a second document/revision', async () => {
  const h = harness(); await h.execute(); const replay = await h.execute();
  assert.equal(replay.action, 'already_imported'); assert.equal(replay.database_written, false);
  assert.equal(h.rows().length, 1); assert.equal(h.revisions().length, 1);
});

test('later clinical edits are preserved and stop replay instead of inserting a duplicate', async () => {
  const h = harness(); await h.execute(); h.rows()[0].content = 'Modificado por clínica'; h.rows()[0].version = 2;
  await assert.rejects(h.execute(), { code: 'PROTOCOL_IMPORT_SNAPSHOT_CHANGED' });
  assert.equal(h.rows().length, 1); assert.equal(h.rows()[0].version, 2);
});

for (const field of ['failRevision', 'failJournal']) test(`${field} rolls back document and revision`, async () => {
  const h = harness(); h.options[field] = true; await assert.rejects(h.execute());
  assert.equal(h.rows().length, 0); assert.equal(h.revisions().length, 0);
  assert.equal(h.events.at(-1)[0], 'rollback');
});

test('postcommit journal failure recovers through source-hash replay without duplicate', async () => {
  const h = harness(); h.options.failCommitJournal = true; await assert.rejects(h.execute());
  assert.equal(h.rows().length, 1); h.options.failCommitJournal = false;
  assert.equal((await h.execute()).action, 'already_imported');
});

test('clinic group changed or missing durable journal rejects before any writes', async () => {
  const h = harness(); h.options.group = 999;
  await assert.rejects(h.execute(), { code: 'PROTOCOL_CLINIC_GROUP_CHANGED' }); assert.equal(h.rows().length, 0);
  await assert.rejects(command.applyProtocolDraftPlan({ db: h.db, service: h.service, plan: h.plan, sourceBytes: bytes, approvedHash: h.plan.plan_sha256 }), { code: 'PROTOCOL_DURABLE_JOURNAL_REQUIRED' });
});

test('ordinary actorless save cannot opt into technical import via HTTP payload', async () => {
  const h = harness();
  await assert.rejects(h.service.save({ clinicId: 72, actorId: null, payload: { ...h.plan.payload, importedSource: { actor_kind: 'system_import' }, transaction: {} } }), { code: 'protocol_import_actor_required' });
  const routes = fs.readFileSync(path.resolve(__dirname, '../../routes/treatmentDocumentation.routes.js'), 'utf8');
  assert.doesNotMatch(routes, /importedSource|transaction:/);
  assert.match(routes, /service\.save\(\{ \.\.\.req\.documentationContext, payload: req\.body \}\)/);
});

test('technical import cannot approve, associate treatments or update an existing document', async () => {
  const h = harness(); const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const importedSource = { actor_kind: 'system_import', source_system: 'cliniccloud', source_sha256: h.plan.source_sha256 };
  for (const update of [{ status: 'approved' }, { treatment_ids: [1] }, { kind: 'aftercare' }]) {
    await assert.rejects(h.service.save({ clinicId: 72, actorId: null, payload: { ...h.plan.payload, ...update }, transaction, importedSource }), { code: 'protocol_import_actor_required' });
  }
  await assert.rejects(h.service.save({ clinicId: 72, actorId: null, id: 1, payload: h.plan.payload, transaction, importedSource }), { code: 'protocol_import_actor_required' });
});

test('normal human save retains its managed transaction and revision behavior', async () => {
  const h = harness(); await h.service.save({ clinicId: 72, actorId: 7, payload: h.plan.payload });
  assert.equal(h.events.filter(event => event[0] === 'begin').length, 1);
  assert.equal(h.rows()[0].created_by, 7); assert.equal(h.revisions()[0].actor_id, 7);
});

test('nullable actor migration is scoped and its rollback cannot erase system audit', async () => {
  const changes = []; const q = { changeColumn: async (...args) => changes.push(args), sequelize: { query: async () => [[{ pending: 1 }]] } };
  await migration.up(q, { INTEGER: 'INTEGER' }); assert.equal(changes.length, 3);
  assert(changes.every(change => change[2].allowNull === true));
  await assert.rejects(migration.down(q, { INTEGER: 'INTEGER' }), /System-import audit records exist/);
  assert.equal(changes.length, 3);
});
