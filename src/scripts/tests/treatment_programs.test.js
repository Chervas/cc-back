'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const contract = require('../../lib/treatmentPrograms.contract');
const { createTreatmentProgramsService } = require('../../services/treatmentPrograms.service');
const { createTreatmentProgramsController } = require('../../controllers/treatmentPrograms.controller');

const profile = { version: 1, phases: [{ key: 'main', label: '', duration_minutes: 30, installation_ids: [8], professionals: { mode: 'any', ids: [7], preferred_id: 7 } }] };
const treatment = (extra = {}) => ({ id_tratamiento: 10, nombre: 'Tratamiento sintético', codigo: 'TEST', origen: 'clinica', clinica_id: 72, activo: true, sesiones_defecto: 1, duracion_min: 30, precio_base: '121.00', clinical_config: { catalog_status: 'active', booking_profile: profile }, ...extra });
const body = (extra = {}) => ({ name: 'Programa sintético', kind: 'program', status: 'draft', total_price: 620, appointments: [{ key: 'first', label: 'Cita 1', treatment_ids: [10], offset_days: 0 }, { key: 'second', label: 'Cita 2', treatment_ids: [10], offset_days: 7 }], ...extra });
const clone = (value) => JSON.parse(JSON.stringify(value));

function harness({ treatments = [treatment()], installations = [{ id: 8 }], professionals = [{ doctor_id: 7 }] } = {}) {
  const state = { programs: [], revisions: [], queries: [], transactions: 0, failRevision: false };
  function model(data) {
    return Object.assign(clone(data), { toJSON() { return Object.fromEntries(Object.entries(this).filter(([, value]) => typeof value !== 'function')); }, async update(values) { Object.assign(this, clone(values)); return this; } });
  }
  function matches(value, where) {
    return Reflect.ownKeys(where).every((key) => {
      const expected = where[key];
      if (key === Op.and) return expected.every((item) => item.val !== undefined || matches(value, item));
      if (key === Op.or) return expected.some((item) => matches(value, item));
      if (expected && typeof expected === 'object') {
        if (expected[Op.in]) return expected[Op.in].includes(value[key]);
        if (expected[Op.like]) return String(value[key] || '').includes(expected[Op.like].replace(/%/g, ''));
      }
      return value[key] === expected;
    });
  }
  const db = {
    sequelize: { queue: Promise.resolve(), transaction(callback) {
      const run = this.queue.then(async () => {
        state.transactions += 1;
        const before = { programs: state.programs.map((r) => clone(r.toJSON())), revisions: clone(state.revisions) };
        try { return await callback({ LOCK: { UPDATE: 'UPDATE' } }); }
        catch (error) { state.programs = before.programs.map(model); state.revisions = before.revisions; throw error; }
      });
      this.queue = run.catch(() => {}); return run;
    } },
    Clinica: { async findOne(query) { state.queries.push(['clinic', query]); return [66, 72].includes(query.where.id_clinica) ? { id_clinica: query.where.id_clinica, grupoClinicaId: 9 } : null; } },
    Tratamiento: { async findAll(query) { state.queries.push(['treatments', query]); return treatments.filter((t) => matches(t, query.where)).slice(query.offset || 0, (query.offset || 0) + (query.limit || 1000)); }, async count(query) { return treatments.filter((t) => matches(t, query.where)).length; } },
    Instalacion: { async findAll(query) { state.queries.push(['installations', query]); return installations; } },
    DoctorClinica: { async findAll(query) { state.queries.push(['professionals', query]); return professionals; } },
    TreatmentProgram: {
      async findOne(query) { state.queries.push(['program', query]); return state.programs.find((r) => matches(r, query.where)) || null; },
      async create(data) { const row = model({ id: state.programs.length + 1, ...data }); state.programs.push(row); return row; },
      async findAll(query) { state.queries.push(['programs', query]); return state.programs.filter((r) => matches(r, query.where)).slice(query.offset || 0, (query.offset || 0) + query.limit); },
      async count(query) { return state.programs.filter((r) => matches(r, query.where)).length; },
    },
    TreatmentProgramRevision: { async create(data) { if (state.failRevision) throw new Error('synthetic revision failure'); state.revisions.push(clone(data)); } },
  };
  let counter = 0;
  return { state, service: createTreatmentProgramsService({ db, now: () => new Date('2026-09-07T00:00:00Z'), newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` }) };
}

test('draft definitions normalize simple fields without inventing appointments or cadence', () => {
  const value = contract.normalizeValues({ name: 'Borrador', kind: 'program' });
  assert.deepEqual(value.appointments, []); assert.equal(value.total_price, null); assert.equal(value.status, 'draft');
  assert.throws(() => contract.normalizeValues(body({ total_price: '12.999' })), /decimales/);
  assert.throws(() => contract.normalizeValues(body({ appointments: [{ key: 'a', treatment_ids: [10, 10] }] })), /repetir/);
  assert.throws(() => contract.normalizeValues(body({ appointments: [{ key: 'a', treatment_ids: [10], offset_days: true }] })), /días/);
});
test('backend resolves names, durations and profiles; preview never writes', async () => {
  const { service, state } = harness();
  const result = await service.preview({ clinicId: 72, payload: body() });
  assert.equal(result.item.summary.appointment_count, 2); assert.equal(result.item.summary.duration_minutes, 60);
  assert.equal(result.item.appointments[0].treatments[0].name, 'Tratamiento sintético');
  assert.equal(result.item.appointments[0].treatments[0].stored_catalog_price, 121);
  assert.equal(result.item.price_semantics, 'gross_tax_included'); assert.equal(result.item.total_price, 620);
  assert.equal(result.item.can_schedule, false); assert.equal(result.item.purchase_enabled, false);
  assert.equal(state.programs.length, 0); assert.equal(state.revisions.length, 0); assert.equal(state.transactions, 0);
  assert.equal(state.queries.filter(([name]) => name === 'treatments').length, 1);
});
test('missing or cross-clinic treatment references remain explicit in drafts, not leaked', async () => {
  const { service } = harness({ treatments: [treatment({ clinica_id: 999, nombre: 'Foreign hidden treatment' })] });
  const result = await service.create({ clinicId: 72, actorId: 1, payload: body() });
  assert.equal(result.created, true); assert.equal(result.item.appointments[0].treatments[0].name, null);
  assert.ok(result.item.summary.issues.some((i) => i.code === 'treatment_unavailable'));
  assert.ok(!JSON.stringify(result).includes('Foreign hidden'));
});
test('active definitions require valid treatments, cadence and resource eligibility', async () => {
  const { service, state } = harness({ installations: [] });
  await assert.rejects(() => service.create({ clinicId: 72, actorId: 1, payload: body({ status: 'active' }) }), (e) => e.statusCode === 422 && e.details.issues.some((i) => i.code === 'installation_unavailable'));
  assert.equal(state.programs.length, 0);
  const normal = harness();
  await assert.rejects(() => normal.service.create({ clinicId: 72, actorId: 1, payload: body({ status: 'active', appointments: [{ key: 'a', treatment_ids: [10], offset_days: null }] }) }), (e) => e.details.issues.some((i) => i.code === 'cadence_required'));
  const valid = await normal.service.create({ clinicId: 72, actorId: 1, payload: body({ status: 'active' }) });
  assert.equal(valid.item.status, 'active'); assert.equal(valid.item.summary.ready_for_scheduling, true); assert.equal(valid.item.can_schedule, false);
});
test('voucher may omit cadence but must repeat exactly one treatment', async () => {
  const { service } = harness({ treatments: [treatment(), treatment({ id_tratamiento: 11 })] });
  const payload = body({ kind: 'voucher', status: 'active', appointments: [{ key: 'a', treatment_ids: [10], offset_days: null }, { key: 'b', treatment_ids: [10], offset_days: null }] });
  assert.equal((await service.create({ clinicId: 72, actorId: 1, payload })).item.summary.issues.length, 0);
  payload.appointments[1].treatment_ids = [11];
  await assert.rejects(() => service.create({ clinicId: 72, actorId: 1, payload }), (e) => e.details.issues.some((i) => i.code === 'voucher_homogeneous_treatment_required'));
});
test('combined appointment and required team stay draft until joint calendar writer exists', async () => {
  const team = { ...profile, phases: [{ ...profile.phases[0], professionals: { mode: 'all', ids: [7, 9], preferred_id: null } }] };
  const { service } = harness({ treatments: [treatment({ clinical_config: { booking_profile: team } }), treatment({ id_tratamiento: 11 })], professionals: [{ doctor_id: 7 }, { doctor_id: 9 }] });
  const p = body({ appointments: [{ key: 'a', treatment_ids: [10, 11], offset_days: 0 }] });
  const draft = await service.create({ clinicId: 72, actorId: 1, payload: p });
  assert.ok(draft.item.summary.issues.some((i) => i.code === 'combined_appointment_writer_pending'));
  assert.ok(draft.item.summary.issues.some((i) => i.code === 'multi_resource_writer_pending'));
});
test('updates compare expected version under lock and revisions are immutable snapshots', async () => {
  const { service, state } = harness();
  const created = await service.create({ clinicId: 72, actorId: 1, payload: body() });
  const saved = await service.update({ clinicId: 72, actorId: 1, id: created.item.id, payload: { expected_version: 1, name: 'Nombre nuevo' } });
  assert.equal(saved.item.version, 2); assert.equal(state.revisions.length, 2);
  assert.equal(state.revisions[0].snapshot.name, 'Programa sintético'); assert.equal(state.revisions[1].snapshot.name, 'Nombre nuevo');
  await assert.rejects(() => service.update({ clinicId: 72, actorId: 1, id: created.item.id, payload: { expected_version: 1, notes: 'stale' } }), (e) => e.statusCode === 409 && e.details.current_version === 2);
  assert.equal(state.revisions.length, 2);
  assert.ok(state.queries.some(([name, q]) => name === 'program' && q.lock === 'UPDATE'));
});
test('parallel create retries share one definition and reject changed payload for same key', async () => {
  const { service, state } = harness();
  const request = { clinicId: 72, actorId: 1, payload: body({ idempotency_key: 'synthetic-key' }) };
  const results = await Promise.all([service.create(request), service.create(request)]);
  assert.equal(state.programs.length, 1); assert.equal(state.revisions.length, 1);
  assert.deepEqual(results.map((r) => r.created), [true, false]);
  await assert.rejects(() => service.create({ ...request, payload: { ...request.payload, total_price: 621 } }), (e) => e.code === 'program_idempotency_conflict');
  assert.ok(state.queries.some(([name, q]) => name === 'clinic' && q.lock === 'UPDATE'));
});
test('revision failure rolls back definition creation', async () => {
  const { service, state } = harness(); state.failRevision = true;
  await assert.rejects(() => service.create({ clinicId: 72, actorId: 1, payload: body() }));
  assert.equal(state.programs.length, 0); assert.equal(state.revisions.length, 0);
});
test('get/update enforce definition clinic and cannot move it across clinics', async () => {
  const { service } = harness();
  const created = await service.create({ clinicId: 72, actorId: 1, payload: body() });
  await assert.rejects(() => service.get({ clinicId: 66, id: created.item.id }), (e) => e.statusCode === 404);
  await assert.rejects(() => service.update({ clinicId: 72, actorId: 1, id: created.item.id, payload: { clinic_id: 66, expected_version: 1 } }), (e) => e.code === 'program_scope_immutable');
});
test('options and list paginate on backend and annotate old multi-session offers', async () => {
  const { service } = harness({ treatments: [treatment({ sesiones_defecto: 5 })] });
  const options = await service.options({ clinicId: 72, query: { page: 1, page_size: 10 } });
  assert.equal(options.items[0].legacy_voucher_offer, true); assert.equal(options.items[0].default_sessions, 5); assert.equal(options.total, 1);
  await service.create({ clinicId: 72, actorId: 1, payload: body() });
  const list = await service.list({ clinicId: 72, query: { kind: 'program', page_size: 1 } });
  assert.equal(list.items.length, 1); assert.equal(list.total, 1); assert.equal(list.page_size, 1);
  await assert.rejects(() => service.list({ clinicId: 72, query: { page_size: 200 } }), (e) => e.statusCode === 400);
});
test('controller enforces appointments.view reads and clinic.settings.edit writes/preview', async () => {
  const calls = []; const response = { set() { return this; }, status(code) { this.statusCode = code; return this; }, json(value) { this.value = value; return this; } };
  const programs = { ...contract, list: async () => ({ items: [] }), preview: async () => ({ item: {} }) };
  const controller = createTreatmentProgramsController({ programs, canAccess: async (request) => { calls.push(request); return true; } });
  const req = { userData: { userId: 1 }, method: 'GET', query: { clinic_id: 72 }, body: {}, params: {} };
  await controller.list(req, response, (e) => { throw e; });
  await controller.preview({ ...req, method: 'POST' }, response, (e) => { throw e; });
  assert.deepEqual(calls.map((c) => c.featureKey), ['appointments.view', 'clinic.settings.edit']);
  const denied = createTreatmentProgramsController({ programs, canAccess: async () => false });
  let error; await denied.list(req, response, (e) => { error = e; }); assert.equal(error.statusCode, 403);
  await denied.list({ ...req, userData: null }, response, (e) => { error = e; }); assert.equal(error.statusCode, 401);
});
