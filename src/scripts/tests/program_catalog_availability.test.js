'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { createProgramCatalogAvailabilityService, programPreviewReference, hasProgramPreviewQuery } = require('../../services/programCatalogAvailability.service');

const capabilities = { simple: true, multi: true, relativeSteps: true };
const phase = (key, minutes, room, doctor) => ({ key, label: key, duration_minutes: minutes,
  installation_ids: [room], professionals: { mode: 'any', ids: [doctor], preferred_id: doctor } });
function fixture(patch = {}, options = {}) {
  const item = { id: 'owned-program', clinic_id: 72, version: 3, status: 'active', kind: 'program', purchase_enabled: true,
    commercial_ready: true, summary: { issues: [] }, appointments: [{ key: 'first', label: 'Primera sesión', treatments: [
      { id: 1, name: 'Preparación', booking_profile: { version: 1, phases: [phase('prep', 5, 10, 1)] } },
      { id: 2, name: 'Técnica', booking_profile: { version: 1, phases: [phase('care', 40, 20, 2)] } },
    ] }, { key: 'second', label: 'Segunda sesión', treatments: [{ id: 3, name: 'Otra técnica',
      booking_profile: { version: 1, phases: [phase('other', 60, 30, 3)] } }] }], ...patch };
  const calls = [];
  const service = createProgramCatalogAvailabilityService({ programs: { get: async input => { calls.push(input); return { item }; } },
    enabled: () => true, capabilities: () => capabilities, ...options });
  return { item, calls, resolve: (query = {}) => service.resolve({ clinicId: 72,
    query: { program_id: 'owned-program', program_version: '3', duracion_min: '15', ...query } }) };
}

test('catalog preview composes every first-session treatment and keeps authoritative duration rather than calendar granularity', async () => {
  const f = fixture(), result = await f.resolve();
  assert.equal(result.metadata.duration_minutes, 45); assert.equal(result.profile.phases.length, 2);
  assert.deepEqual(result.profile.phases.map(row => row.installation_ids), [[10], [20]]);
  assert.deepEqual(result.metadata, { program_id: 'owned-program', program_version: 3, session_key: 'first', position: 1,
    label: 'Primera sesión', duration_minutes: 45 });
  assert.deepEqual(f.calls, [{ id: 'owned-program', clinicId: 72 }]);
});
test('a selected later session must belong to the same versioned catalog; vouchers share the canonical resolver', async () => {
  const f = fixture({ kind: 'voucher' });
  assert.equal((await f.resolve({ program_session_key: 'second' })).metadata.duration_minutes, 60);
  await assert.rejects(f.resolve({ program_session_key: 'foreign' }), { code: 'program_session_not_found', statusCode: 404 });
});
test('V4 preview keeps offsets and whole visit span, not the sum or array order', async () => {
  const f = fixture({ appointments: [{ key: 'relative', label: 'Relativa', treatments: [{ id: 1, name: 'Combinado', booking_profile: {
    version: 4, phases: [{ ...phase('later', 30, 20, 2), start_offset_minutes: 15 },
      { ...phase('first', 30, 10, 1), start_offset_minutes: 0 }] } }] }] });
  const result = await f.resolve(); assert.equal(result.metadata.duration_minutes, 45);
  assert.deepEqual(result.profile.phases.map(row => row.start_offset_minutes), [15, 0]);
});
test('explicit unresolved durations do not inherit duracion_min or other browser-chosen minutes', async () => {
  const f = fixture(); f.item.appointments[0].treatments[0].booking_profile.phases[0].duration_minutes = null;
  await assert.rejects(f.resolve(), { code: 'program_duration_required', statusCode: 422 });
});
test('closed gates and unsupported relative runtime cannot announce a slot', async () => {
  const f = fixture({}, { enabled: () => false }); await assert.rejects(f.resolve(), { code: 'program_booking_disabled', statusCode: 503 });
  assert.equal(f.calls.length, 0);
  const restricted = fixture({}, { capabilities: () => ({ simple: false, multi: false }) });
  await assert.rejects(restricted.resolve(), { code: 'booking_profile_runtime_unavailable' });
});
test('foreign scope, stale version and non-bookable catalogs remain explicit failures', async () => {
  for (const patch of [{ clinic_id: 66 }, { id: 'foreign' }]) await assert.rejects(fixture(patch).resolve(), { code: 'program_not_found', statusCode: 404 });
  await assert.rejects(fixture({ version: 4 }).resolve(), { code: 'program_version_conflict', statusCode: 409 });
  for (const patch of [{ status: 'draft' }, { status: 'archived' }, { purchase_enabled: false }, { commercial_ready: false },
    { kind: 'invented' }, { summary: { issues: [{ code: 'bad' }] } }]) {
    await assert.rejects(fixture(patch).resolve(), { code: 'program_not_ready', statusCode: 422 });
  }
});
test('conflicting treatment/ignore and clinical-duration overrides never substitute the server-owned session', async () => {
  for (const query of [{ tratamiento_id: '1' }, { ignore_cita_id: '999' }, { duration_minutes: '10' }, { phase_durations: '{}' },
    { booking_profile: '{}' }, { profile: '{}' }, { ignoreAppointmentIds: ['999'] }, { selections: '{}' }, { force: 'true' }]) {
    const f = fixture(); await assert.rejects(f.resolve(query), { code: 'program_preview_invalid', statusCode: 400 });
    assert.equal(f.calls.length, 0);
  }
});
test('partial/malformed catalog references are rejected rather than silently treated as generic availability', () => {
  assert.equal(hasProgramPreviewQuery({ program_version: '1' }), true);
  assert.equal(hasProgramPreviewQuery({}), false); assert.equal(programPreviewReference({}), null);
  for (const query of [{ program_version: '1' }, { program_id: 'owned' }, { program_id: 'owned', program_version: '1.0' },
    { program_id: 'owned', program_version: [] }, { program_id: [], program_version: '1' },
    { program_id: 'owned', program_version: '1', program_session_key: '../other' }]) assert.throws(() => programPreviewReference(query));
});
test('matrix budget counts compatible starting pairs, keeping All usable while bounding actual solver work', () => {
  const source = fs.readFileSync(require.resolve('../../controllers/disponibilidad.controller'), 'utf8');
  const start = source.indexOf('function assertProgramPreviewBudget('), end = source.indexOf('async function prepareRangePayloads(', start);
  assert(start > 0 && end > start);
  const method = vm.runInNewContext(source.slice(start, end) + '\nassertProgramPreviewBudget;', {
    parseIntSafe: value => value == null ? null : Number(value),
    parseIntArray: value => value == null ? [] : Array.isArray(value) ? value.map(Number) : String(value).split(',').map(Number),
    bookingError: (code, message, _details, statusCode) => Object.assign(Error(message), { code, statusCode }),
  });
  const profile = { version: 1, phases: [phase('first', 45, 10, 1)] };
  const queries = Array.from({ length: 18 }, (_, index) => ({ instalacion_id: String(index + 10),
    doctor_ids: Array.from({ length: 10 }, (_, doctor) => doctor + 1), from_local: '09:00', to_local: '20:00' }));
  assert.doesNotThrow(() => method(profile, Array(42).fill('2030-01-07'), queries, 5));
  const large = { version: 1, phases: [{ ...phase('first', 45, 10, 1), installation_ids: Array.from({ length: 18 }, (_, i) => i + 10),
    professionals: { mode: 'any', ids: Array.from({ length: 10 }, (_, i) => i + 1), preferred_id: 1 } }] };
  assert.throws(() => method(large, Array(7).fill('2030-01-07'), queries, 5), { code: 'program_grid_too_large', statusCode: 400 });
  large.phases[0].professionals.mode = 'all';
  assert.throws(() => method(large, Array(7).fill('2030-01-07'), queries, 5), { code: 'program_grid_too_large', statusCode: 400 },
    'Every visible team-member column actually repeats the solver and must count toward its budget');
  assert.throws(() => method(profile, Array(42).fill('2030-01-07'), Array(80).fill(queries[0]), 5),
    { code: 'program_grid_too_large', statusCode: 400 }, 'Repeated columns are work too; duplicate inputs cannot bypass the budget');
});
