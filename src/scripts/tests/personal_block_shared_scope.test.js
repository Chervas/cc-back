'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createPersonalBlockScopes, loadPersonalBlockScopes, checkPersonalBlockScopePermissions } = require('../../lib/personal-block-scope');
const { loadLegacyAvailabilitySnapshot } = require('../../lib/availability-request-snapshot');
const links = () => [
  { id: 23, doctor_id: 53, clinica_id: 72, activo: true, shared_schedule_source_id: 23 },
  { id: 24, doctor_id: 53, clinica_id: 66, activo: true, shared_schedule_source_id: 23 },
  { id: 25, doctor_id: 53, clinica_id: 99, activo: true, shared_schedule_source_id: null },
];
const block = (patch = {}) => ({ id: 291, doctor_id: 53, clinica_id: 72, aplica_a_todas_clinicas: false,
  fecha_inicio: new Date('2026-10-29T11:15:00Z'), fecha_fin: new Date('2026-10-29T12:00:00Z'),
  recurrente: 'none', tipo: 'ausencia', motivo: 'Fictitious', excepciones: [], ...patch });
test('one definition anchored in either linked clinic applies to both and never the independent third clinic', () => {
  const scope = createPersonalBlockScopes(links());
  for (const anchor of [72, 66]) {
    const row = block({ clinica_id: anchor });
    assert.deepEqual(scope.metadata(row), { scope: 'linked', canonical_clinica_id: anchor, effective_clinic_ids: [66, 72] });
    assert.equal(scope.applies(row, 72), true); assert.equal(scope.applies(row, 66), true); assert.equal(scope.applies(row, 99), false);
    assert.deepEqual(scope.filter([row, row], 66).map(row => row.id), [291]);
  }
  assert.deepEqual(scope.metadata(block({ clinica_id: 99 })), { scope: 'clinic', canonical_clinica_id: 99, effective_clinic_ids: [99] });
});
test('explicit global semantics remain global; unlink and relink change projection without altering definitions', () => {
  const before = block(), frozen = JSON.stringify(before), shared = createPersonalBlockScopes(links());
  for (const row of [block({ clinica_id: null }), block({ aplica_a_todas_clinicas: true }), block({ aplica_a_todas_clinicas: 1 })]) {
    assert.equal(shared.metadata(row).scope, 'global'); assert.equal(shared.applies(row, 999), true);
  }
  const independent = createPersonalBlockScopes(links().map(row => ({ ...row, shared_schedule_source_id: null })));
  assert.equal(independent.applies(before, 66), false); assert.equal(independent.applies(before, 72), true);
  assert.equal(shared.applies(before, 66), true); assert.equal(JSON.stringify(before), frozen);
});
test('broken, foreign-doctor and inactive shared sources fail closed; receive-appointments does not narrow personal absence scope', () => {
  for (const rows of [links().filter(row => row.id !== 23), links().map(row => row.id === 24 ? { ...row, doctor_id: 54 } : row),
    links().map(row => row.id === 24 ? { ...row, activo: false } : row)])
    assert.throws(() => createPersonalBlockScopes(rows), error => error.code === 'personal_block_scope_review_required');
  assert.equal(createPersonalBlockScopes(links().map(row => ({ ...row, recibe_citas: false }))).applies(block(), 66), true);
});

function snapshotFixture(definitions) {
  const Op = Object.fromEntries(['in','or','lt','lte','gt','ne'].map(key => [key, Symbol(key)]));
  const horarios = Array.from({ length: 7 }, (_, dia_semana) => ({ dia_semana, activo: true, hora_inicio: '09:00', hora_fin: '20:00' }));
  const calls = [];
  const rows = links().map(row => ({ ...row, recibe_citas: true, horarios }));
  const db = { Sequelize: { Op }, DoctorHorario: {}, DoctorHorarioExcepcion: {}, DoctorBloqueoExcepcion: {},
    DoctorClinica: { findAll: async query => { calls.push(query); return rows.filter(row => (!query.where.clinica_id || row.clinica_id === query.where.clinica_id)
      && query.where.doctor_id[Op.in].includes(row.doctor_id)); } },
    DoctorBloqueo: { findAll: async query => definitions.map(row => query.attributes
      ? { ...Object.fromEntries(query.attributes.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])), excepciones: row.excepciones } : row) },
  };
  return { db, calls, clinic: { id_clinica: 66, configuracion: { timezone: 'Europe/Madrid' } },
    fetchClinicHorarios: async () => horarios, readers: { resourceAppointments: async () => [], resourceInstallationBlocks: async () => [] } };
}
test('real snapshot black blocks and red availability use the same linked definitions, excluding independent clinic blocks', async () => {
  const f = snapshotFixture([block(), block({ id: 292, clinica_id: 99 })]);
  const snapshot = await loadLegacyAvailabilitySnapshot({ ...f, dates: ['2026-10-29'], doctorIds: [53] });
  assert.deepEqual(snapshot.personalBlocks.map(row => row.id), [291]);
  assert.deepEqual(snapshot.day('2026-10-29').doctorBlocks.get(53).map(row => row.id), [291]);
  assert.deepEqual(snapshot.personalBlocks[0].effective_clinic_ids, [66,72]);
});
test('snapshot SQL projection retains recurrence Until and cancellation exceptions', async () => {
  const date = '2026-10-29', f = snapshotFixture([block({ recurrente: 'weekly', recurrente_hasta: '2026-10-22',
    fecha_inicio: new Date('2026-10-22T10:15:00Z'), fecha_fin: new Date('2026-10-22T11:00:00Z') })]);
  const snapshot = await loadLegacyAvailabilitySnapshot({ ...f, dates: [date], doctorIds: [53] });
  assert.deepEqual(snapshot.personalBlocks, []); assert.equal(snapshot.day(date).doctorBlocks.get(53)?.length || 0, 0);
  const cancel = snapshotFixture([block({ recurrente: 'weekly', excepciones: [{ fecha: date, cancelado: true }] })]);
  const cancelled = await loadLegacyAvailabilitySnapshot({ ...cancel, dates: [date], doctorIds: [53] });
  assert.deepEqual(cancelled.personalBlocks, []); assert.equal(cancelled.day(date).doctorBlocks.get(53)?.length || 0, 0);
});
test('shared metadata is loaded once per request, never per block or cell', async () => {
  const f = snapshotFixture([]), scope = await loadPersonalBlockScopes({ db: f.db, doctorIds: [53], links: [links()[1]] });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].skipSharedScheduleProjection, true);
  for (let n=0;n<100;n++) scope.applies(block({ id:n+1 }), 66);
  assert.equal(f.calls.length, 1);
});
test('public black and red projections preserve authorized reasons and redact an inaccessible anchor without releasing time', async () => {
  for (const readableBlockClinicIds of [[], [72]]) {
    const f = snapshotFixture([block({ tipo: 'vacaciones', motivo: 'Private leave reason' })]);
    const snapshot = await loadLegacyAvailabilitySnapshot({ ...f, dates: ['2026-10-29'], doctorIds: [53], readableBlockClinicIds });
    const black = snapshot.personalBlocks[0], red = snapshot.day('2026-10-29').doctorBlocks.get(53)[0];
    for (const row of [black, red]) {
      assert.equal(row.id, 291); assert.equal(Number(row.clinica_id),72);
      assert.equal(row.motivo, readableBlockClinicIds.length ? 'Private leave reason' : '');
      assert.equal(row.tipo, readableBlockClinicIds.length ? 'vacaciones' : 'ausencia');
    }
    assert.equal(black.start_local,'2026-10-29T12:15'); assert.equal(black.end_local,'2026-10-29T13:00');
  }
});
test('editing a linked restriction requires every affected clinic, while global retains its global permission check', async () => {
  const scope = createPersonalBlockScopes(links()), visited = [];
  assert.equal(await checkPersonalBlockScopePermissions(scope.metadata(block()), async id => { visited.push(id); return id === 66; }), false);
  assert.deepEqual(visited, [66,72]);
  assert.equal(await checkPersonalBlockScopePermissions(scope.metadata(block()), async id => [66,72].includes(id)), true);
  visited.length=0;
  assert.equal(await checkPersonalBlockScopePermissions(scope.metadata(block({clinica_id:null})), async id => {visited.push(id);return false;}), false);
  assert.deepEqual(visited,[null]);
});
