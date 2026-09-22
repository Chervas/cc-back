'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createBookingEquipmentRegistry } = require('../../services/bookingEquipmentRegistry.service');
const Op = { in: Symbol('in'), gt: Symbol('gt'), ne: Symbol('ne'), or: Symbol('or') };
function matches(row, where = {}) { return Reflect.ownKeys(where).every(k => {
  if (k === Op.or) return where[k].some(w => matches(row, w));
  const v = where[k];
  if (v && typeof v === 'object') return Reflect.ownKeys(v).every(op => op === Op.in ? v[op].includes(row[k])
    : op === Op.gt ? new Date(row[k]) > new Date(v[op]) : op === Op.ne ? row[k] !== v[op] : false);
  return row[k] === v;
}); }
function fixture({ allowed = [72, 66, 99], feature = true, busy = false } = {}) {
  const calls = [], tx = { LOCK: { UPDATE: 'UPDATE' }, options: { isolationLevel: 'READ COMMITTED' } };
  const wrap = row => Object.assign(row, { update: async data => Object.assign(row, data) });
  const clinics = [wrap({ id_clinica: 72, grupoClinicaId: 9, equipment_booking_enabled: feature }),
    wrap({ id_clinica: 66, grupoClinicaId: 9, equipment_booking_enabled: feature }), wrap({ id_clinica: 99, grupoClinicaId: 10, equipment_booking_enabled: true })];
  const rooms = [{ id: 9, clinica_id: 72, nombre: 'C9', activo: true }];
  const units = [wrap({ id: 1, name: 'EXION', family_key: 'exion', owner_clinic_id: 72, group_id: 9,
    mobility: 'mobile', status: 'available', turnaround_minutes: 0, home_installation_id: 9, revision: 1 })];
  let shares = [{ equipment_id: 1, clinic_id: 72 }, { equipment_id: 1, clinic_id: 66 }];
  const policies = [wrap({ installation_id: 9, mode: 'all', equipment_ids: [], revision: 1 })];
  const occupancy = busy ? [{ appointment_id: 1, phase_key: 'care', resource_kind: 'equipment', resource_key: 'equipment:1', end_at: '2099-01-01T00:00:00Z' },
    { appointment_id: 1, phase_key: 'care', resource_kind: 'installation', resource_key: 'installation:9', end_at: '2099-01-01T00:00:00Z' }] : [];
  const query = (name, rows, args) => { calls.push(name); return rows.filter(r => matches(r, args?.where)); };
  const db = {
    Sequelize: { Op }, sequelize: { transaction: async (options, work) => work(tx) },
    Clinica: { findByPk: async id => { calls.push('clinic'); return clinics.find(c => c.id_clinica === id); },
      findAll: async args => query('clinics', clinics, args) },
    Instalacion: { findByPk: async id => rooms.find(r => r.id === id), findAll: async args => query('rooms', rooms, args) },
    InstallationPhysicalAlias: { findAll: async () => [] },
    BookingEquipment: { findByPk: async id => units.find(u => u.id === id), findAll: async args => query('units', units, args),
      create: async data => { const row = wrap({ ...data, id: 2, revision: 1 }); units.push(row); return row; } },
    BookingEquipmentClinic: { findAll: async args => query('shares', shares, args), findOne: async args => query('shares', shares, args)[0],
      destroy: async args => { shares = shares.filter(s => !matches(s, args.where)); }, bulkCreate: async values => shares.push(...values) },
    BookingEquipmentRoomPolicy: { findAll: async args => query('policies', policies, args), findByPk: async id => policies.find(p => p.installation_id === id),
      upsert: async value => { Object.assign(policies[0], value); } },
    AppointmentBookingOccupancy: { findAll: async args => query('occupancy', occupancy, args) },
    AppointmentBookingResource: { upsert: async row => calls.push(row.resource_key), findByPk: async () => ({}) },
  };
  const authorized = [];
  const service = createBookingEquipmentRegistry({ db, enabled: () => true, authorize: async (featureKey, id) => {
    authorized.push([featureKey, id]); if (!allowed.includes(id)) throw Object.assign(new Error('access_policy_forbidden'), { status: 403 });
  } });
  return { service, db, calls, authorized, units, policies };
}
const payload = { name: 'EXION', family_key: 'exion', mobility: 'mobile', status: 'available', home_installation_id: 9,
  turnaround_minutes: 0, revision: 1, clinic_ids: [72, 66] };

test('disabled clinic read returns no inventory query or UI equipment data', async () => {
  const f = fixture({ feature: false });
  assert.deepEqual(await f.service.read(72), { clinic_id: 72, enabled: false, runtime_available: true, can_edit: true, units: [], rooms: [], sharing_clinics: [] });
  assert.deepEqual(f.calls, ['clinic']);
});
test('unauthorized users cannot inspect or change machinery', async () => {
  const f = fixture({ allowed: [] });
  await assert.rejects(f.service.read(72), { status: 403 });
  await assert.rejects(f.service.saveUnit(72, 1, payload), { status: 403 });
  assert.equal(f.calls.length, 0);
});
test('equipment changes require permissions for every sharing clinic', async () => {
  const f = fixture({ allowed: [72] });
  await assert.rejects(f.service.saveUnit(72, 1, payload), { status: 403 });
  assert.equal(f.units[0].revision, 1);
  assert(f.authorized.some(([, id]) => id === 66));
});
test('cannot share devices with an unrelated group even with permissions', async () => {
  const f = fixture();
  await assert.rejects(f.service.saveUnit(72, 1, { ...payload, clinic_ids: [72, 99] }), { code: 'booking_equipment_scope' });
});
test('non-owner cannot mutate an equipment borrowed from a peer', async () => {
  await assert.rejects(fixture().service.saveUnit(66, 1, { ...payload, clinic_ids: [66] }), { code: 'booking_equipment_not_found' });
});
test('stale revision cannot overwrite another configuration', async () => {
  await assert.rejects(fixture().service.saveUnit(72, 1, { ...payload, revision: 0 }), { code: 'booking_equipment_changed' });
});
test('future reservations prevent maintenance, relocation or withdrawing a share', async () => {
  for (const patch of [{ status: 'maintenance' }, { turnaround_minutes: 15 }, { clinic_ids: [72] }]) {
    const f = fixture({ busy: true });
    await assert.rejects(f.service.saveUnit(72, 1, { ...payload, ...patch }), { code: 'booking_equipment_in_use' });
    assert.equal(f.units[0].revision, 1);
  }
});
test('renaming does not cancel reservations or overwrite their historical labels', async () => {
  const f = fixture({ busy: true });
  await f.service.saveUnit(72, 1, { ...payload, name: 'EXION 1' });
  assert.equal(f.units[0].revision, 2);
  assert(f.calls.includes('equipment:1'));
});
test('cannot disable equipment management while shared units remain assigned', async () => {
  await assert.rejects(fixture().service.setEnabled(72, false), { code: 'booking_equipment_in_use' });
});
test('tightening mobile room policy revalidates existing phase reservations', async () => {
  const f = fixture({ busy: true });
  await assert.rejects(f.service.saveRoomPolicy(72, 9, { mode: 'none', revision: 1 }), { code: 'booking_equipment_in_use' });
  assert.equal(f.policies[0].mode, 'all');
  await f.service.saveRoomPolicy(72, 9, { mode: 'selected', equipment_ids: [1], revision: 1 });
  assert.equal(f.policies[0].mode, 'selected');
});
test('withdrawal is reversible and preserves the physical unit and its historical identity', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.archiveUnit(72, 1, 1), { id: 1, archived: true, revision: 2 });
  assert.equal(f.units[0].status, 'unavailable');
  assert.equal(f.units.length, 1);
  assert.equal((await f.service.setEnabled(72, false)).enabled, false);
  await f.service.setEnabled(72, true);
  await f.service.saveUnit(72, 1, { ...payload, revision: 2 });
  assert.equal(f.units[0].status, 'available');
  assert.equal(f.units[0].revision, 3);
});
test('withdrawal cannot discard future bookings, stale revisions or sharing ACL', async () => {
  await assert.rejects(fixture({ busy: true }).service.archiveUnit(72, 1, 1), { code: 'booking_equipment_in_use' });
  await assert.rejects(fixture().service.archiveUnit(72, 1, 0), { code: 'booking_equipment_changed' });
  await assert.rejects(fixture({ allowed: [72] }).service.archiveUnit(72, 1, 1), { status: 403 });
});
test('clinic membership changes cannot invalidate shared equipment and have a no-query ordinary path', async () => {
  const { assertClinicEquipmentMembershipChangeSafe: check } = require('../../services/bookingEquipmentMembership.service');
  const f = fixture();
  await check({ db: f.db, clinic: { id_clinica: 72, equipment_booking_enabled: false } });
  assert.equal(f.calls.length, 0);
  await assert.rejects(check({ db: f.db, clinic: { id_clinica: 72, equipment_booking_enabled: true } }), { code: 'booking_equipment_in_use' });
});
test('inventory DTO and ordinary edits preserve the explicit sharing list', async () => {
  const f = fixture();
  assert.deepEqual((await f.service.read(72)).units[0].clinic_ids, [66, 72]);
  const edit = { ...payload, name: 'EXION 1' }; delete edit.clinic_ids;
  await f.service.saveUnit(72, 1, edit);
  assert.deepEqual((await f.service.read(72)).units[0].clinic_ids, [66, 72]);
});

test('inventory exposes only authorized same-group sharing choices and edit capability', async () => {
  const all = await fixture().service.read(72);
  assert.deepEqual(all.sharing_clinics.map(c => c.id), [72, 66]);
  assert.equal(all.units[0].can_edit, true);
  const restricted = await fixture({ allowed: [72] }).service.read(72);
  assert.deepEqual(restricted.sharing_clinics.map(c => c.id), [72]);
  assert.equal(restricted.units[0].can_edit, false);
});
test('basic editor derives a family on creation and preserves it on rename', async () => {
  const f = fixture();
  const creation = { ...payload, name: 'Ondas acústicas BTL' }; delete creation.family_key;
  await f.service.saveUnit(72, null, creation);
  assert.equal(f.units[1].family_key, 'ondas-acusticas-btl');
  const edit = { ...payload, name: 'EXION renovado' }; delete edit.family_key;
  await f.service.saveUnit(72, 1, edit);
  assert.equal(f.units[0].family_key, 'exion');
});
