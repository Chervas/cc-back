'use strict';
// Exercise the real controller handlers without app bootstrap or live services.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../controllers/personal.controller'), 'utf8');
const start = source.indexOf('async function sharingPermissions(');
const end = source.indexOf('exports.getScheduleForCurrent =', start);
assert(start > 0 && end > start);
const code = source.slice(start, end);
const controlled = (suffix, status) => Object.assign(Error('Synthetic controlled failure'), { code: 'personal_schedule_sharing_' + suffix, status });
function fixture({ allowed = [10, 20], editable = [10, 20], access = true } = {}) {
  const state = { doctor_id: 2, revision: '4', clinicas: [10, 20, 30].map(clinica_id => ({ clinica_id,
    nombre_clinica: 'Fictitious ' + clinica_id, active: true, shared_schedule_source_id: clinica_id === 30 ? null : 201 })),
  groups: [{ source_clinica_id: 10, source_doctor_clinica_id: 201, clinic_ids: [10, 20], clinic_names: ['Fictitious 10', 'Fictitious 20'] }] };
  const calls = { state: 0, preview: 0, apply: 0, mutation: 0, errors: 0, contexts: [], permissionChecks: [] };
  const db = { testOnly: true }, tx = { testOnly: true };
  const service = {
    async getScheduleSharing(options) { assert.equal(options.db, db); calls.state++; return structuredClone(state); },
    async previewScheduleSharing(options) { calls.preview++; assert.equal(options.db, db);
      if (!await options.checkAll({ clinicIds: options.input.clinic_ids })) throw controlled('forbidden', 403);
      return { preview_hash: 'a'.repeat(64), clinic_ids: options.input.clinic_ids }; },
    async applyScheduleSharing(options) { calls.apply++; assert.equal(options.transaction, tx);
      if (!await options.checkAll({ clinicIds: options.input.clinic_ids })) throw controlled('forbidden', 403);
      return { preview: { affected_clinic_ids: options.input.clinic_ids }, revision: '4' }; },
  };
  const context = { exports: {}, Number, Set, Promise, console: { error: () => calls.errors++ },
    scheduleDb: () => db, scheduleSharing: service,
    getAllowedClinicIdsForActorTarget: async () => allowed,
    canAccessTargetPersonal: async () => access,
    canEditHorarios: async (actorId, doctorId, clinicId) => { calls.permissionChecks.push(clinicId); return editable.includes(Number(clinicId)); },
    sendPersonalScheduleTransferError: (error, res) => { if (!error?.code?.startsWith('personal_schedule_sharing_')) return false;
      res.status(error.status).json({ code: error.code }); return true; },
    personalCalendarUndo: { sendUndoError: () => false }, sendCalendarMutationError: () => false,
    withPersonalAvailabilityMutation: async (req, doctorId, mutate) => { calls.mutation++; assert.equal(doctorId, 2);
      const result = await mutate(tx); state.revision = '5'; req.personalAvailabilityUndo = { token: 'owned-receipt', ttl_ms: 20000 }; return result; },
    availabilityResponse: (req, value) => ({ ...value, ...(req.personalAvailabilityUndo ? { undo: req.personalAvailabilityUndo } : {}) }),
    scheduleSharingContext: async (doctorId, clinicId, transaction) => { assert.equal(transaction, tx); calls.contexts.push(clinicId); return { source: { horarios: [{ id: 100 }] } }; },
    findCrossClinicScheduleConflicts: async () => [],
    rejectPersonalScheduleTransfer: (status, payload) => { throw Object.assign(Error(payload.message), { ...payload, status, code: 'personal_schedule_sharing_external_conflict' }); },
  };
  vm.runInNewContext(code, context, { filename: 'personal.sharing.handlers.js' });
  const request = body => ({ userData: { userId: 1 }, params: { id: '2' }, body: body || {
    operation: 'link', clinic_ids: [10, 20], source_clinica_id: 10, expected_revision: '4', preview_hash: 'a'.repeat(64), same_site_confirmed: true } });
  const invoke = async (name, req = request()) => { const res = { statusCode: 200, body: null,
    status(value) { this.statusCode = value; return this; }, json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; } };
  await context.exports[name](req, res); return res; };
  return { state, calls, context, service, request, invoke };
}
test('sharing endpoints reject invalid identity or inaccessible professional before reading or mutating schedules', async () => {
  for (const name of ['getScheduleSharing', 'previewScheduleSharing', 'updateScheduleSharing']) {
    const f = fixture(), missing = f.request(); delete missing.userData;
    assert.equal((await f.invoke(name, missing)).statusCode, 401);
    const bad = f.request(); bad.params.id = '0'; assert.equal((await f.invoke(name, bad)).statusCode, 400);
    assert.equal(f.calls.state + f.calls.preview + f.calls.apply + f.calls.mutation, 0);
    const denied = fixture({ access: false }); assert.equal((await denied.invoke(name)).statusCode, 403);
    assert.equal(denied.calls.state + denied.calls.preview + denied.calls.apply + denied.calls.mutation, 0);
  }
});
test('sharing GET conceals unavailable member clinics and complete group labels while retaining a restricted-link marker', async () => {
  const f = fixture({ allowed: [10], editable: [10] }), res = await f.invoke('getScheduleSharing');
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body.clinicas.map(row => row.clinica_id), [10]);
  assert.deepEqual(res.body.groups, []); assert.equal(res.body.can_manage, false);
  assert.equal(res.body.clinicas[0].shared_schedule_source_id, 201); assert(!JSON.stringify(res.body).includes('Fictitious 20'));
});
test('sharing preview requires edit authority on every affected clinic and returns the controlled 403', async () => {
  const f = fixture({ editable: [10] }), res = await f.invoke('previewScheduleSharing');
  assert.equal(res.statusCode, 403); assert.equal(res.body.code, 'personal_schedule_sharing_forbidden');
  assert.deepEqual(f.calls.permissionChecks, [10, 20]); assert.equal(f.calls.mutation, 0); assert.equal(f.calls.apply, 0);
});
test('sharing PUT checks each linked clinic inside one calendar mutation and returns the advanced durable revision with Undo', async () => {
  const f = fixture(), res = await f.invoke('updateScheduleSharing');
  assert.equal(res.statusCode, 200); assert.equal(res.body.revision, '5'); assert.equal(res.body.undo.ttl_ms, 20000);
  assert.deepEqual(f.calls.contexts, [10, 20]); assert.equal(f.calls.mutation, 1); assert.equal(f.calls.apply, 1); assert.equal(f.calls.state, 1);
});
test('sharing PUT preserves the service stale-preview 409 and does not reload or report successful Undo', async () => {
  const f = fixture(); f.service.applyScheduleSharing = async () => { throw controlled('preview_changed', 409); };
  const res = await f.invoke('updateScheduleSharing'); assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'personal_schedule_sharing_preview_changed'); assert.equal(f.calls.state, 0); assert(!res.body.undo);
});
test('sharing PUT rejects conflicting third-site shifts inside the mutation and unlink avoids that link-only validation', async () => {
  const f = fixture(); f.context.findCrossClinicScheduleConflicts = async () => [{ id: 900 }];
  const conflict = await f.invoke('updateScheduleSharing'); assert.equal(conflict.statusCode, 409); assert.equal(f.calls.state, 0);
  const g = fixture(); g.context.findCrossClinicScheduleConflicts = async () => { throw Error('unlink must not enter link-only validator'); };
  const req = g.request(); req.body.operation = 'unlink'; req.body.clinic_ids = [20];
  assert.equal((await g.invoke('updateScheduleSharing', req)).statusCode, 200); assert.deepEqual(g.calls.contexts, []);
});
test('an uncertain post-commit read reports a reload instruction rather than claiming that the mutation was not saved', async () => {
  const f = fixture(); f.service.getScheduleSharing = async () => { throw Error('Synthetic read failure'); };
  const res = await f.invoke('updateScheduleSharing'); assert.equal(res.statusCode, 500); assert.equal(f.calls.apply, 1);
  assert.equal(f.state.revision, '5'); assert.match(res.body.message, /Actualiza la vista antes de reintentarlo/);
  assert(!/no se (?:guard|aplic)/i.test(res.body.message));
});

test('identity merge advances both locked calendar revisions before commit and rolls back if that advance fails', async () => {
  const mergeStart = source.indexOf('exports.mergePersonalAccounts =');
  const mergeEnd = source.indexOf('exports.getPersonalBloqueosPermissions =', mergeStart);
  assert(mergeStart > 0 && mergeEnd > mergeStart);
  for (const failAdvance of [false, true]) {
    const order = [], db = {}, tx = { options: { isolationLevel: 'READ COMMITTED' },
      commit: async () => order.push('commit'), rollback: async () => order.push('rollback') };
    const users = [2, 3].map(id_usuario => ({ id_usuario, email_usuario: 'owned-' + id_usuario + '@invalid.local',
      save: async () => order.push('save:' + id_usuario) }));
    const context = { exports: {}, console: { error: () => {} },
      sequelize: { transaction: async options => { assert.equal(options.isolationLevel, 'READ COMMITTED'); return tx; } },
      parseIntOrNull: value => Number(value), actorCanMergeUsers: async () => true,
      Usuario: { findByPk: async id => users.find(user => user.id_usuario === id) },
      UsuarioClinica: { findAll: async () => [] }, DoctorClinica: { findAll: async () => [] },
      DoctorBloqueo: { update: async () => order.push('blocks') }, CitaPaciente: { update: async () => order.push('appointments') },
      assertDoctorIdentityMutable: async options => { assert.equal(options.transaction, tx); order.push('mutexes-and-identity-guard'); },
      personalCalendarUndo: { bumpRevisions: async options => { assert.equal(options.db, db); assert.equal(options.transaction, tx);
        assert.deepEqual(Array.from(options.doctorIds), [2, 3]); order.push('revision:2-and-3'); if (failAdvance) throw Error('Synthetic CAS failure'); } },
      scheduleDb: () => db, require: id => { assert.equal(id, '../../models'); return db; },
      normalizeEmail: value => value || null, sendCalendarMutationError: () => false,
    };
    vm.runInNewContext(source.slice(mergeStart, mergeEnd), context);
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    await context.exports.mergePersonalAccounts({ userData: { userId: 1 }, body: { principal_user_id: 2, secondary_user_id: 3 } }, res);
    assert.equal(order[0], 'mutexes-and-identity-guard');
    assert.equal(order.at(-2), 'revision:2-and-3'); assert.equal(order.at(-1), failAdvance ? 'rollback' : 'commit');
    assert.equal(res.statusCode, failAdvance ? 500 : 200);
  }
});
