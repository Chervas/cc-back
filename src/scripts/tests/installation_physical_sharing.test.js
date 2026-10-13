'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSharingRequest, physicalMembers, createInstallationPhysicalSharingService,
  installationSharingListMetadata } = require('../../services/installationPhysicalSharing.service');

function fixture({ shared = true, enabled = true, hiddenClinics = [], deniedEdits = [] } = {}) {
  const Op = Object.fromEntries(['in', 'or', 'ne', 'gt', 'lt'].map(key => [key, Symbol(key)]));
  let stores = {
    clinics: [{ id_clinica: 66, nombre_clinica: 'BS Capilar', grupoClinicaId: 29 },
      { id_clinica: 72, nombre_clinica: 'BS Medical', grupoClinicaId: 29 },
      { id_clinica: 99, nombre_clinica: 'Other group', grupoClinicaId: 31 }],
    rooms: [{ id: 76, clinica_id: 66, nombre: 'C3', activo: true, profesionales_permitidos: [120],
      updated_at: '2026-10-13T09:00:00Z', capacidad: 1, allow_overlap_confirmation: false, overlap_capacity_unlimited: false,
      tipo: 'consulta', es_exclusiva: true, tratamientos_exclusivos: [91] },
    { id: 77, clinica_id: 72, nombre: 'C3', activo: true, profesionales_permitidos: [141],
      updated_at: '2026-10-13T09:00:00Z', capacidad: 1, allow_overlap_confirmation: false, overlap_capacity_unlimited: false },
    { id: 90, clinica_id: 99, nombre: 'C3', activo: true, profesionales_permitidos: [] }],
    aliases: shared ? [{ installation_id: 76, canonical_installation_id: 77, group_id: 29 }] : [],
    doctors: [{ doctor_id: 120, clinica_id: 66, activo: true, recibe_citas: true, doctor: { nombre: 'Dr', apellidos: 'Loza' } },
      { doctor_id: 141, clinica_id: 72, activo: true, recibe_citas: true, doctor: { nombre: 'Mar' } },
      { doctor_id: 53, clinica_id: 72, activo: true, recibe_citas: true, doctor: { nombre: 'Dra', apellidos: 'Celia' } },
      { doctor_id: 50, clinica_id: 72, activo: true, recibe_citas: false, doctor: { nombre: 'Disabled' } }],
    appointments: [], occupancies: [], blocks: [], roomPolicies: [], equipment: [], roomHours: [],
    clinicHours: [{ clinica_id: 72, dia_semana: 1, activo: true, hora_inicio: '10:00', hora_fin: '18:00' }],
  };
  const calls = [], afterCommit = [];
  let writes = 0;
  const matches = (row, where = {}) => Reflect.ownKeys(where).every(key => {
    if (key === Op.or) return where[key].some(part => matches(row, part));
    const value = where[key], actual = row[key];
    if (value && typeof value === 'object' && !(value instanceof Date)) return Reflect.ownKeys(value).every(op => {
      if (op === Op.in) return value[op].includes(actual);
      if (op === Op.ne) return actual !== value[op];
      if (op === Op.gt) return new Date(actual) > new Date(value[op]);
      if (op === Op.lt) return new Date(actual) < new Date(value[op]);
      return false;
    });
    return actual === value;
  });
  const wrap = (table, row) => row && ({ ...row,
    toJSON: () => ({ ...row }),
    update: async (values, options) => {
      assert.equal(options.transaction, tx); writes++; calls.push(`update:${table}:${row.id}`);
      Object.assign(row, values); row.updated_at = '2026-10-13T10:00:00Z'; return wrap(table, row);
    },
    reload: async () => wrap(table, row),
  });
  const select = (table, query = {}) => stores[table].filter(row => matches(row, query.where)).filter(row => {
    if (table !== 'occupancies' || !query.include?.length) return true;
    const appointment = stores.appointments.find(item => item.id_cita === row.appointment_id);
    return appointment && query.include.every(include => matches(appointment, include.where));
  });
  const model = (table, pk = 'id') => ({
    findByPk: async (id, query = {}) => {
      if (query.lock) calls.push(`lock:${table}:${id}:${query.lock}`);
      return wrap(table, stores[table].find(row => row[pk] === id));
    },
    findAll: async (query = {}) => select(table, query).map(row => {
      if (table === 'rooms' && query.include?.length) row = { ...row, clinica: stores.clinics.find(item => item.id_clinica === row.clinica_id) };
      return wrap(table, row);
    }),
    findOne: async (query = {}) => wrap(table, select(table, query)[0]),
    create: async (values, options) => {
      assert.equal(options.transaction, tx); writes++; calls.push(`create:${table}`);
      const row = { ...values };
      if (pk === 'id' && !row.id) row.id = Math.max(0, ...stores[table].map(item => item.id || 0)) + 1;
      stores[table].push(row); return wrap(table, row);
    },
  });
  const tx = { options: { isolationLevel: 'READ COMMITTED' }, LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' },
    afterCommit: callback => afterCommit.push(callback) };
  const db = { Sequelize: { Op }, Usuario: {}, Clinica: model('clinics', 'id_clinica'),
    Instalacion: model('rooms'), InstallationPhysicalAlias: model('aliases', 'installation_id'),
    DoctorClinica: model('doctors'), CitaPaciente: model('appointments', 'id_cita'),
    AppointmentBookingOccupancy: model('occupancies'), InstalacionBloqueo: model('blocks'),
    BookingEquipmentRoomPolicy: model('roomPolicies', 'installation_id'), BookingEquipment: model('equipment'),
    ClinicaHorario: model('clinicHours'), InstalacionHorario: { bulkCreate: async (rows, options) => {
      assert.equal(options.transaction, tx); writes++; stores.roomHours.push(...rows);
    } },
    sequelize: { transaction: async (options, callback) => {
      assert.equal(options.isolationLevel, 'READ COMMITTED');
      const before = structuredClone(stores), beforeWrites = writes;
      try { const result = await callback(tx); calls.push('commit'); for (const callback of afterCommit) await callback(); return result; }
      catch (error) { stores = before; writes = beforeWrites; calls.push('rollback'); throw error; }
    } },
  };
  const authorize = async (feature, id) => {
    if (hiddenClinics.includes(id) || feature === 'clinic.settings.edit' && deniedEdits.includes(id)) {
      const error = Error('access_policy_forbidden'); error.status = 403; throw error;
    }
  };
  const service = createInstallationPhysicalSharingService({ db, authorize, enabled: () => enabled,
    now: () => new Date('2026-10-13T09:00:00Z'), realtimeEnabled: false,
    lockResources: async ({ resourceKeys, transaction }) => {
      assert.equal(transaction, tx); for (const key of [...new Set(resourceKeys)].sort()) calls.push(`resource:${key}`);
    },
    calendarMutation: async options => {
      assert.equal(options.transaction, tx); assert.equal(options.installationId, 76);
      calls.push('calendar:before'); const value = await options.mutate(tx); calls.push('calendar:after'); return value;
    },
  });
  const request = async () => { const result = await service.context({ installationId: 76 });
    return { revision: result.revision, memberships: structuredClone(result.memberships) }; };
  const mutate = async transaction => {
    const room = await db.Instalacion.findByPk(76, { transaction }); await room.update({ nombre: 'C3 edited' }, { transaction });
    return room;
  };
  return { db, service, request, mutate, authorize, calls, stores: () => stores, writes: () => writes };
}

function controllerFor(f) {
  const fs = require('node:fs'), vm = require('node:vm');
  const { createRequire } = require('node:module');
  const file = require.resolve('../../controllers/instalaciones.controller');
  const localRequire = createRequire(file);
  const handlers = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { exports: handlers, console, Date, Map, Set, Promise,
    require: name => {
      if (name === 'express-async-handler') return handler => handler;
      if (name === '../../models') return f.db;
      if (name === '../lib/access-policy') return {
        assertUserCanAccessFeature: input => f.authorize(input.featureKey, input.clinicId),
        getAccessibleClinicIdsForFeature: async () => [66,72],
      };
      if (name === '../services/appointmentCalendarMutation.service') return {
        ...localRequire(name), withCalendarMutation: input => input.transaction ? input.mutate(input.transaction)
          : f.db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, input.mutate),
      };
      if (name === '../services/installationPhysicalSharing.service') return {
        ...localRequire(name), createInstallationPhysicalSharingService: () => f.service,
      };
      return localRequire(name);
    },
  }, { filename: file });
  return handlers;
}

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}

test('sharing DTO is strict, bounded and cannot infer clinical membership from strings or empty selected lists', () => {
  const member = { clinic_id: 66, installation_id: 76, enabled: true, professional_mode: 'all', professional_ids: [] };
  const good = { revision: 'a'.repeat(64), memberships: [member] };
  assert.deepEqual(normalizeSharingRequest(good), good);
  for (const value of [null, {}, { ...good, admin: true }, { ...good, revision: 'stale' },
    { ...good, memberships: [{ ...member, clinic_id: '66' }] }, { ...good, memberships: [member, member] },
    { ...good, memberships: [{ ...member, professional_mode: 'selected' }] },
    { ...good, memberships: [{ ...member, professional_ids: [120] }] },
    { ...good, memberships: [{ ...member, installation_id: undefined }] }]) {
    assert.throws(() => normalizeSharingRequest(value), { code: 'installation_sharing_invalid' });
  }
});

test('context exposes one physical key, member clinic provenance and only active receiving professionals', async () => {
  const f = fixture(); const context = await f.service.context({ installationId: 76 });
  assert.equal(context.canonical_installation_id, 77); assert.equal(context.group_id, 29);
  assert.equal(context.sharing_enabled, true); assert.equal(context.can_configure, true);
  assert.deepEqual(context.memberships.map(member => [member.clinic_id, member.installation_id]), [[66,76], [72,77]]);
  assert.deepEqual(context.clinics[1].professionals.map(person => person.doctor_id), [141,53]);
  assert(!context.clinics.some(clinic => clinic.clinic_id === 99)); assert.equal(f.writes(), 0);
  assert.doesNotMatch(JSON.stringify(context), /password|email|paciente|DoctorClinica/);
});

test('new-room context starts with its own clinic and unrestricted receiving professionals without inventing an installation ID', async () => {
  const f = fixture(); const context = await f.service.context({ clinicId: 66 });
  assert.equal(context.installation_id, null); assert.equal(context.canonical_installation_id, null);
  assert.deepEqual(context.memberships, [{ clinic_id: 66, installation_id: null, enabled: true, professional_mode: 'all', professional_ids: [] }]);
  assert.equal(context.sharing_enabled, false); assert.equal(context.can_configure, true); assert.equal(f.writes(), 0);
});

test('an unauthorized peer is not disclosed and partial context cannot configure the whole room', async () => {
  const f = fixture({ hiddenClinics: [72] }); const context = await f.service.context({ installationId: 76 });
  assert.equal(context.can_configure, false); assert.equal(context.canonical_installation_id, null);
  assert.deepEqual(context.clinics.map(clinic => clinic.clinic_id), [66]);
  assert.deepEqual(context.memberships.map(member => member.installation_id), [76]);
  assert.doesNotMatch(JSON.stringify(context), /BS Medical|"installation_id":77|"clinic_id":72/);
  await assert.rejects(f.service.save({ installationId: 76, sharing: await f.request(), mutate: f.mutate }),
    { code: 'installation_sharing_forbidden', status: 403 });
  assert.equal(f.writes(), 0);
});

test('clinic edit permission is exposed, and all current members require edit authority before any write', async () => {
  const f = fixture({ deniedEdits: [72] }); const context = await f.service.context({ installationId: 76 });
  assert.equal(context.can_configure, false); assert.equal(context.clinics[1].can_edit, false);
  await assert.rejects(f.service.save({ installationId: 76, sharing: await f.request(), mutate: f.mutate }), { status: 403 });
  assert.equal(f.writes(), 0);
});

test('one combined save preserves IDs, canonical identity, appointment evidence and clinic-local professional lists', async () => {
  const f = fixture(); const request = await f.request();
  request.memberships.find(member => member.clinic_id === 72).professional_ids = [53,141];
  const aliasesBefore = structuredClone(f.stores().aliases);
  await f.service.save({ installationId: 76, sharing: request, mutate: f.mutate });
  assert.deepEqual(f.stores().aliases, aliasesBefore);
  assert.deepEqual(f.stores().rooms.filter(room => [76,77].includes(room.id)).map(room => [room.id, room.clinica_id, room.profesionales_permitidos]),
    [[76,66,[120]], [77,72,[53,141]]]);
  assert.equal(f.stores().rooms[0].nombre, 'C3 edited'); assert.equal(f.stores().rooms[1].nombre, 'C3');
  assert.deepEqual(f.stores().appointments, []); assert.deepEqual(f.stores().occupancies, []);
  assert(f.calls.indexOf('lock:clinics:66:UPDATE') < f.calls.indexOf('resource:installation:77'));
  assert(f.calls.indexOf('lock:clinics:72:UPDATE') < f.calls.indexOf('resource:installation:77'));
  assert(f.calls.includes('calendar:after')); assert.equal(f.calls.at(-1), 'commit');
});

test('a changed revision rolls back before ordinary room changes', async () => {
  const f = fixture(); const request = await f.request(); f.stores().rooms[1].updated_at = '2026-10-13T10:00:00Z';
  await assert.rejects(f.service.save({ installationId: 76, sharing: request, mutate: f.mutate }), { code: 'installation_sharing_stale' });
  assert.equal(f.writes(), 0); assert.equal(f.stores().rooms[0].nombre, 'C3');
});

test('same room name never links installations and cannot authorize an unrelated group', async () => {
  const f = fixture({ shared: false }); const request = await f.request();
  assert.equal(f.stores().aliases.length, 0);
  request.memberships.push({ clinic_id: 99, installation_id: 90, enabled: true, professional_mode: 'all', professional_ids: [] });
  await assert.rejects(f.service.save({ installationId: 76, sharing: request, mutate: f.mutate }), { code: 'installation_sharing_forbidden' });
  assert.equal(f.stores().aliases.length, 0); assert.equal(f.writes(), 0);
});

test('an empty room can explicitly link another clinic while preserving its original identity and hours', async () => {
  const f = fixture({ shared: false }); const request = await f.request();
  request.memberships.push({ clinic_id: 72, installation_id: 77, enabled: true, professional_mode: 'selected', professional_ids: [141] });
  await f.service.save({ installationId: 76, sharing: request, mutate: f.mutate });
  assert.deepEqual(f.stores().aliases, [{ installation_id: 77, canonical_installation_id: 76, group_id: 29 }]);
  assert.equal(f.stores().rooms[1].clinica_id, 72); assert.deepEqual(f.stores().roomHours, []);
  assert(f.calls.includes('resource:installation:76')); assert(f.calls.includes('resource:installation:77'));
});

for (const dependency of ['future appointment', 'past ledger', 'future block', 'machinery policy', 'fixed machinery']) {
  test(`linking ${dependency} fails closed without rekeying frozen reservations`, async () => {
    const f = fixture({ shared: false }); const request = await f.request();
    request.memberships.push({ clinic_id: 72, installation_id: 77, enabled: true, professional_mode: 'all', professional_ids: [] });
    if (dependency === 'future appointment') f.stores().appointments.push({ id_cita: 1, instalacion_id: 77, estado: 'pendiente', fin: '2026-10-14T10:00:00Z' });
    if (dependency === 'past ledger') f.stores().occupancies.push({ id: 1, installation_id: 77, resource_key: 'installation:77', end_at: '2025-01-01T10:00:00Z' });
    if (dependency === 'future block') f.stores().blocks.push({ id: 1, instalacion_id: 77, fecha_fin: '2026-10-14T10:00:00Z' });
    if (dependency === 'machinery policy') f.stores().roomPolicies.push({ installation_id: 77, mode: 'all' });
    if (dependency === 'fixed machinery') f.stores().equipment.push({ id: 1, home_installation_id: 77 });
    await assert.rejects(f.service.save({ installationId: 76, sharing: request, mutate: f.mutate }), { code: 'installation_sharing_review_required' });
    assert.equal(f.writes(), 0); assert.equal(f.stores().aliases.length, 0);
  });
}

test('topology changes require the booking gate, while existing memberships can be edited with it closed', async () => {
  const f = fixture({ shared: false, enabled: false }); const request = await f.request();
  request.memberships.push({ clinic_id: 72, installation_id: 77, enabled: true, professional_mode: 'all', professional_ids: [] });
  await assert.rejects(f.service.save({ installationId: 76, sharing: request, mutate: f.mutate }), { code: 'installation_sharing_runtime_required' });
  assert.equal(f.writes(), 0);
  const existing = fixture({ enabled: false });
  await existing.service.save({ installationId: 76, sharing: await existing.request(), mutate: existing.mutate });
  assert.equal(existing.stores().aliases[0].canonical_installation_id, 77);
});

test('removing clinic use disables its member but never deletes or moves the physical reference', async () => {
  const f = fixture(); const request = await f.request(); request.memberships[1].enabled = false;
  await f.service.save({ installationId: 76, sharing: request, mutate: f.mutate });
  assert.equal(f.stores().rooms[1].activo, false);
  assert.deepEqual(f.stores().aliases, [{ installation_id: 76, canonical_installation_id: 77, group_id: 29 }]);
  const context = await f.service.context({ installationId: 76 });
  assert.equal(context.canonical_installation_id, 77); assert.equal(context.sharing_enabled, false);
  assert.equal(context.clinics[1].installations[0].active, false); assert.equal(context.memberships[1].enabled, false);
});

test('a future legacy or segmented appointment prevents disabling its clinical member', async () => {
  for (const segmented of [false,true]) {
    const f = fixture(); const request = await f.request(); request.memberships[1].enabled = false;
    f.stores().appointments.push({ id_cita: 1, instalacion_id: segmented ? 76 : 77, estado: 'recordatorio_confirmado', fin: '2026-10-14T10:00:00Z' });
    if (segmented) f.stores().occupancies.push({ id: 1, appointment_id: 1, installation_id: 77, resource_key: 'installation:77', end_at: '2026-10-14T10:00:00Z' });
    await assert.rejects(f.service.save({ installationId: 76, sharing: request, mutate: f.mutate }), { code: 'installation_sharing_review_required' });
    assert.equal(f.stores().rooms[1].activo, true); assert.equal(f.writes(), 0);
  }
});

test('closing the runtime gate cannot allow withdrawal of a future frozen segmented reservation', async () => {
  const f = fixture({ enabled: false }); const request = await f.request(); request.memberships[1].enabled = false;
  f.stores().appointments.push({ id_cita: 1, instalacion_id: 76, estado: 'pendiente', fin: '2026-10-14T10:00:00Z' });
  f.stores().occupancies.push({ id: 1, appointment_id: 1, installation_id: 77, resource_key: 'installation:77', end_at: '2026-10-14T10:00:00Z' });
  await assert.rejects(f.service.save({ installationId: 76, sharing: request, mutate: f.mutate }), { code: 'installation_sharing_review_required' });
  assert.equal(f.stores().rooms[1].activo, true); assert.equal(f.writes(), 0);
});

test('future reservations prevent narrowing permissions, but permission expansion does not rewrite reservations', async () => {
  const f = fixture(); f.stores().rooms[1].profesionales_permitidos = [];
  const request = await f.request(); request.memberships[1].professional_mode = 'selected'; request.memberships[1].professional_ids = [141];
  f.stores().appointments.push({ id_cita: 1, instalacion_id: 77, estado: 'pendiente', fin: '2026-10-14T10:00:00Z' });
  await assert.rejects(f.service.save({ installationId: 76, sharing: request, mutate: f.mutate }), { code: 'installation_sharing_review_required' });
  const expansion = fixture(); const expanded = await expansion.request(); expanded.memberships[1].professional_ids = [53,141];
  expansion.stores().appointments.push({ id_cita: 1, instalacion_id: 77, estado: 'pendiente', fin: '2026-10-14T10:00:00Z' });
  const before = structuredClone(expansion.stores().appointments);
  await expansion.service.save({ installationId: 76, sharing: expanded, mutate: expansion.mutate });
  assert.deepEqual(expansion.stores().appointments, before);
});

test('unchanged historical professional lists survive, but disabled staff cannot be newly selected', async () => {
  const f = fixture(); f.stores().rooms[1].profesionales_permitidos = [50];
  await f.service.save({ installationId: 76, sharing: await f.request(), mutate: f.mutate });
  assert.deepEqual(f.stores().rooms[1].profesionales_permitidos, [50]);
  const invalid = fixture(); const request = await invalid.request(); request.memberships[1].professional_ids = [50,141];
  await assert.rejects(invalid.service.save({ installationId: 76, sharing: request, mutate: invalid.mutate }),
    { code: 'installation_sharing_professionals_invalid', status: 400 });
  assert.equal(invalid.writes(), 0);
});

test('professionals cannot be borrowed from another clinic even within the same physical room', async () => {
  const f = fixture(); const request = await f.request(); request.memberships[1].professional_ids = [120];
  await assert.rejects(f.service.save({ installationId: 76, sharing: request, mutate: f.mutate }), { code: 'installation_sharing_professionals_invalid' });
  assert.equal(f.writes(), 0);
});

test('creating a member copies room settings and target-clinic hours, without enrolling professionals or modifying clinic configuration', async () => {
  const f = fixture({ shared: false }); const request = await f.request();
  request.memberships.push({ clinic_id: 72, installation_id: null, enabled: true, professional_mode: 'selected', professional_ids: [141] });
  const doctors = structuredClone(f.stores().doctors), clinics = structuredClone(f.stores().clinics);
  await f.service.save({ installationId: 76, sharing: request, mutate: f.mutate });
  const member = f.stores().rooms.find(room => room.id > 90);
  assert.equal(member.clinica_id, 72); assert.deepEqual(member.profesionales_permitidos, [141]);
  assert.equal(member.es_exclusiva, true); assert.deepEqual(member.tratamientos_exclusivos, [91]);
  assert.deepEqual(f.stores().roomHours, [{ instalacion_id: member.id, dia_semana: 1, activo: true, hora_inicio: '10:00', hora_fin: '18:00' }]);
  assert.deepEqual(f.stores().doctors, doctors); assert.deepEqual(f.stores().clinics, clinics);
  assert.deepEqual(f.stores().aliases, [{ installation_id: member.id, canonical_installation_id: 76, group_id: 29 }]);
});

test('missing existing members, changing their IDs, and alias chains fail before ordinary edits', async () => {
  for (const change of ['omit', 'replace']) {
    const f = fixture(); const request = await f.request();
    if (change === 'omit') request.memberships.pop(); else request.memberships[1].installation_id = null;
    await assert.rejects(f.service.save({ installationId: 76, sharing: request, mutate: f.mutate }), { code: 'installation_sharing_invalid' });
    assert.equal(f.writes(), 0);
  }
  assert.throws(() => physicalMembers(76, [{ installation_id: 76, canonical_installation_id: 77 },
    { installation_id: 77, canonical_installation_id: 90 }]), { code: 'installation_sharing_review_required' });
});

test('failure after an ordinary edit rolls back both room fields and sharing membership changes', async () => {
  const f = fixture({ shared: false }); const request = await f.request();
  request.memberships.push({ clinic_id: 72, installation_id: null, enabled: true, professional_mode: 'all', professional_ids: [] });
  f.db.InstallationPhysicalAlias.create = async () => { throw Error('storage failure'); };
  await assert.rejects(f.service.save({ installationId: 76, sharing: request, mutate: f.mutate }), /storage failure/);
  assert.equal(f.writes(), 0); assert.equal(f.stores().rooms.length, 3); assert.equal(f.stores().rooms[0].nombre, 'C3');
  assert.deepEqual(f.stores().aliases, []); assert.deepEqual(f.stores().roomHours, []);
});

test('list clinic column includes authorized peers and disabled membership without exposing unauthorized clinic IDs', async () => {
  const f = fixture(); f.stores().rooms[1].activo = false;
  const items = [f.stores().rooms[0]], aliases = f.stores().aliases;
  assert.deepEqual(await installationSharingListMetadata({ db: f.db, items, aliases, accessibleClinicIds: [66,72] }), {
    76: [{ clinic_id: 66, name: 'BS Capilar', enabled: true }, { clinic_id: 72, name: 'BS Medical', enabled: false }],
  });
  assert.deepEqual(await installationSharingListMetadata({ db: f.db, items, aliases, accessibleClinicIds: [66] }), {
    76: [{ clinic_id: 66, name: 'BS Capilar', enabled: true }],
  });
});

test('a single-clinic list finds third-clinic members through the physical key without exposing an unauthorized fourth member', async () => {
  const f = fixture();
  f.stores().clinics.push({ id_clinica: 73, nombre_clinica: 'Third clinic', grupoClinicaId: 29 });
  f.stores().rooms.push({ id: 92, clinica_id: 73, activo: true });
  f.stores().aliases.push({ installation_id: 92, canonical_installation_id: 77, group_id: 29 },
    { installation_id: 90, canonical_installation_id: 77, group_id: 29 });
  const rows = await installationSharingListMetadata({ db: f.db, items: [f.stores().rooms[0]],
    aliases: [f.stores().aliases[0]], accessibleClinicIds: [66,72,73] });
  assert.deepEqual(rows[76].map(row => row.clinic_id), [66,72,73]);
  assert.doesNotMatch(JSON.stringify(rows), /Other group|"clinic_id":99/);
});

test('HTTP sharing contexts validate IDs strictly before loading any clinical data', async () => {
  const f = fixture(); const controller = controllerFor(f);
  for (const id of ['0','1e2','66.0','66x','9007199254740992','']) {
    const res = response(); await controller.getSharingContext({ params: {}, query: { clinica_id: id } }, res);
    assert.equal(res.statusCode, 400); assert.equal(f.writes(), 0);
  }
  const res = response(); await controller.getSharingContext({ params: {}, query: { clinica_id: '66' } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.memberships[0].installation_id, null);
});

test('HTTP PUT saves ordinary room fields and per-clinic permissions in one transaction without changing source IDs', async () => {
  const f = fixture(); const controller = controllerFor(f), sharing = await f.request(), res = response();
  sharing.memberships[1].professional_ids = [53,141];
  await controller.update({ params: { id: '76' }, body: { nombre: 'C3 updated through HTTP', physical_sharing: sharing },
    userData: { userId: 1 } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.id, 76);
  assert.equal(f.stores().rooms[0].nombre, 'C3 updated through HTTP');
  assert.deepEqual(f.stores().rooms[1].profesionales_permitidos, [53,141]);
  assert.deepEqual(f.stores().aliases, [{ installation_id: 76, canonical_installation_id: 77, group_id: 29 }]);
  assert.equal(f.calls.filter(call => call === 'commit').length, 1);
});

test('HTTP PUT refuses inconsistent main-professional and shared-professional payloads before any write', async () => {
  const f = fixture(); const res = response();
  await controllerFor(f).update({ params: { id: '76' }, body: { profesionales_permitidos: [141], physical_sharing: await f.request() },
    userData: { userId: 1 } }, res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.code, 'installation_sharing_invalid'); assert.equal(f.writes(), 0);
});

test('HTTP ordinary own-member changes with unchanged normalized capacity never require foreign edit authority or touch its alias', async () => {
  for (const capacity of [1, '1']) {
    const f = fixture({ deniedEdits: [72] }), res = response();
    const originalPeer = structuredClone(f.stores().rooms[1]), originalAlias = structuredClone(f.stores().aliases);
    await controllerFor(f).update({ params: { id: '76' }, body: { nombre: 'Own clinic rename',
      profesionales_permitidos: [], capacidad: capacity, allow_overlap_confirmation: false, overlap_capacity_unlimited: false },
      userData: { userId: 1 } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(f.stores().rooms[0].nombre, 'Own clinic rename'); assert.deepEqual(f.stores().rooms[0].profesionales_permitidos, []);
    assert.deepEqual(f.stores().rooms[1], originalPeer); assert.deepEqual(f.stores().aliases, originalAlias);
  }
});

test('HTTP real shared-capacity changes require edit permission in every clinic and roll back the ordinary fields too', async () => {
  const f = fixture({ deniedEdits: [72] }), res = response(), original = structuredClone(f.stores().rooms);
  await controllerFor(f).update({ params: { id: '76' }, body: { nombre: 'Must not partly save', capacidad: 2 },
    userData: { userId: 1 } }, res);
  assert.equal(res.statusCode, 403); assert.deepEqual(f.stores().rooms, original); assert.equal(f.writes(), 0);
});

test('HTTP actual shared occupancy changes normalize once and propagate identical policies, without changing clinical IDs', async () => {
  const f = fixture(), res = response(), aliases = structuredClone(f.stores().aliases);
  await controllerFor(f).update({ params: { id: '76' }, body: { capacidad: '2',
    allow_overlap_confirmation: true, overlap_capacity_unlimited: false }, userData: { userId: 1 } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(f.stores().rooms.slice(0, 2).map(room => [room.id, room.clinica_id, room.capacidad,
    room.allow_overlap_confirmation, room.overlap_capacity_unlimited]), [[76,66,2,true,false], [77,72,2,true,false]]);
  assert.deepEqual(f.stores().aliases, aliases);
});

test('HTTP a valid new policy can repair an invalid historical tuple, but invalid new policies still fail before writes', async () => {
  const repaired = fixture(), responseRepair = response();
  repaired.stores().rooms[0].allow_overlap_confirmation = true;
  await controllerFor(repaired).update({ params: { id: '76' }, body: { capacidad: 2 }, userData: { userId: 1 } }, responseRepair);
  assert.equal(responseRepair.statusCode, 200, JSON.stringify(responseRepair.body));
  assert.deepEqual(repaired.stores().rooms.slice(0, 2).map(room => [room.capacidad, room.allow_overlap_confirmation]), [[2,true], [2,true]]);
  const invalid = fixture(), responseInvalid = response();
  await controllerFor(invalid).update({ params: { id: '76' }, body: { capacidad: 1, allow_overlap_confirmation: true },
    userData: { userId: 1 } }, responseInvalid);
  assert.equal(responseInvalid.statusCode, 400); assert.equal(responseInvalid.body.code, 'installation_overlap_invalid'); assert.equal(invalid.writes(), 0);
});

test('HTTP PUT and POST reject malformed membership containers with 400 rather than a pre-normalization TypeError', async () => {
  const f = fixture(), controller = controllerFor(f);
  for (const memberships of [{}, '66', null, []]) {
    const body = { clinica_id: 66, nombre: 'C4', tipo: 'consulta',
      physical_sharing: { revision: 'a'.repeat(64), memberships } };
    const update = response();
    await controller.update({ params: { id: '76' }, body, userData: { userId: 1 } }, update);
    assert.equal(update.statusCode, 400); assert.equal(update.body.code, 'installation_sharing_invalid');
    const create = response();
    await controller.create({ body, userData: { userId: 1 } }, create);
    assert.equal(create.statusCode, 400); assert.equal(create.body.code, 'installation_sharing_invalid');
    assert.equal(f.writes(), 0);
  }
});

test('HTTP POST can create a room and a shared member atomically from the draft context', async () => {
  const f = fixture({ shared: false }), controller = controllerFor(f), res = response();
  const context = await f.service.context({ clinicId: 66 });
  const sharing = { revision: context.revision, memberships: context.memberships };
  sharing.memberships.push({ clinic_id: 72, installation_id: null, enabled: true, professional_mode: 'selected', professional_ids: [141] });
  await controller.create({ body: { clinica_id: 66, nombre: 'C4', tipo: 'consulta', physical_sharing: sharing },
    userData: { userId: 1 } }, res);
  assert.equal(res.statusCode, 201); assert.equal(res.body.clinica_id, 66);
  const root = f.stores().rooms.find(room => room.id === res.body.id);
  const alias = f.stores().aliases.find(alias => alias.canonical_installation_id === root.id);
  assert(alias); assert.equal(f.stores().rooms.find(room => room.id === alias.installation_id).clinica_id, 72);
  assert.equal(f.calls.filter(call => call === 'commit').length, 1);
  assert.deepEqual(f.stores().roomHours, [{ instalacion_id: alias.installation_id, dia_semana: 1, activo: true, hora_inicio: '10:00', hora_fin: '18:00' }]);
});

test('HTTP POST cannot partly create a room if the shared-member write fails', async () => {
  const f = fixture({ shared: false }), res = response();
  const context = await f.service.context({ clinicId: 66 });
  f.db.InstallationPhysicalAlias.create = async () => { throw Error('simulated storage failure'); };
  const sharing = { revision: context.revision, memberships: [...context.memberships,
    { clinic_id: 72, installation_id: null, enabled: true, professional_mode: 'all', professional_ids: [] }] };
  const controller = controllerFor(f);
  const log = console.error; console.error = () => {};
  try {
    await controller.create({ body: { clinica_id: 66, nombre: 'C4', tipo: 'consulta', physical_sharing: sharing }, userData: { userId: 1 } }, res);
  } finally { console.error = log; }
  assert.equal(res.statusCode, 500); assert.equal(f.writes(), 0); assert.equal(f.stores().rooms.length, 3);
  assert.deepEqual(f.stores().aliases, []); assert.deepEqual(f.stores().roomHours, []);
});
