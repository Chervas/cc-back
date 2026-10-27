'use strict';
// Real canonical plan, SQL loaders, solver and read-only grid over a freshly
// owned mysqld/socket. Never connects to DEV, CRM, Redis or a provider.
const assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedProgramResumeFixture } = require('./helpers/owned-program-resume-fixture');

withIsolatedCampaignMysql(async owned => {
  const f = await createOwnedProgramResumeFixture(owned, { sessionCount: 3 });
  const { db } = f, { sql, report } = owned, checks = [];
  const current = async (active = 's0', date = '2030-01-07', extra = {}) => {
    const plan = await f.read();
    return { snapshot_sha256: plan.snapshot_sha256, plan_revision: plan.plan_revision, active_key: active,
      sessions: plan.sessions.filter(row => row.scheduling_status === 'pending').map(row => ({ key: row.key, placed: false })),
      grid: { dates: [date], mode: 'doctor', column_ids: [1], context_instalacion_id: 101,
        from_local: '09:00', to_local: '13:00', granularity_min: 5 }, ...extra };
  };
  const grid = async payload => {
    const before = await f.databaseState(), run = sql.query;
    const statements = [];
    sql.query = function (...args) {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.query;
      assert.match(text, /^\s*SELECT\b/i, 'Grid may only issue SELECT statements'); statements.push(text);
      return run.apply(this, args);
    };
    let result;
    try { result = await f.service.availabilityGrid({ ...f.options, payload }); }
    finally { sql.query = run; assert.deepEqual(await f.databaseState(), before, 'Grid changes no domain row'); }
    return { result, statements };
  };
  const at = (result, utc) => result.rows[0].slots.some(row => row.start_utc === utc);
  const check = async (label, work) => { await work(); checks.push(label); };

  await check('complete45-minuteV4profile/5-minuteprecision/serialized-local-and-UTCbounds', async () => {
    const { result } = await grid(await current());
    assert.equal(result.duracion_min, 45); assert.equal(result.granularity_min, 5); assert.equal(result.active_key, 's0');
    assert(at(result, '2030-01-07T08:05:00.000Z'));
    assert(result.rows[0].slots.every(row => Date.parse(row.end_utc) - Date.parse(row.start_utc) === 45 * 60000));
    assert(result.rows[0].slots.every(row => row.start_local && row.end_local && row.phases.length === 2));
  });
  await check('late-phaseforeignaliasoccupancyblocksvisitdespitefreefirstfive-minutes', async () => {
    const peer = await f.peer('alias', '2030-01-07T09:30:00Z');
    try { const { result } = await grid(await current()); assert(!at(result, '2030-01-07T09:00:00.000Z'));
      assert(result.rows[0].unavailable_intervals.some(row => Date.parse(row.start_utc) <= Date.parse('2030-01-07T09:00Z')
        && Date.parse(row.end_utc) > Date.parse('2030-01-07T09:00Z') && row.resource_conflicts.length)); }
    finally { await f.cancelPeer(peer); }
  });
  await check('machineoccupancyandturnaroundremainhard', async () => {
    const peer = await f.peer('machine', '2030-01-07T09:30:00Z');
    try { const { result } = await grid(await current()); assert(!at(result, '2030-01-07T09:00:00.000Z')); }
    finally { await f.cancelPeer(peer); }
  });
  await check('datedsiblingsblockpatientandresourceswhetherplacedornot/activeisnotselfbusy', async () => {
    for (const placed of [false, true]) {
      const payload = await current(); payload.sessions[0].start_at = '2030-01-07T09:00:00Z';
      payload.sessions[1] = { ...payload.sessions[1], start_at: '2030-01-07T10:00:00Z', placed };
      const { result } = await grid(payload);
      assert(at(result, '2030-01-07T09:00:00.000Z')); assert(!at(result, '2030-01-07T09:30:00.000Z'));
    }
  });
  await check('snapshotrevisionandclient-authoredprofileorignoreIDsfailclosed', async () => {
    for (const extra of [{ snapshot_sha256: '0'.repeat(64) }, { plan_revision: '0'.repeat(64) },
      { booking_profile: f.profile }, { ignoreAppointmentIds: [999] }, { capabilities: { simple: true } }, { force: true }]) {
      await assert.rejects(grid({ ...await current(), ...extra }), error => ['program_grid_plan_changed', 'program_grid_invalid'].includes(error.code));
    }
  });
  await check('foreignclinicresourcesrejected/inactivesame-cliniccolumnisdiagnosticnotgreen', async () => {
    const foreign = await current(); foreign.grid.context_instalacion_id = 201;
    await assert.rejects(grid(foreign), { code: 'program_grid_resource_scope', statusCode: 404 });
    await db.DoctorClinica.update({ activo: false }, { where: { doctor_id: 3, clinica_id: 100 } });
    try { const inactive = await current(); inactive.grid.column_ids = [3]; const { result } = await grid(inactive);
      assert.equal(result.rows[0].ok, true); assert.equal(result.rows[0].slots.length, 0); assert(result.rows[0].unavailable_intervals.length); }
    finally { await db.DoctorClinica.update({ activo: true }, { where: { doctor_id: 3, clinica_id: 100 } }); }
  });
  await check('clinicalopeningstillboundsgridwhilestaffpresenceextendsacrossclosures', async () => {
    await db.DoctorHorario.update({ hora_inicio: '05:00', hora_fin: '23:00' }, { where: { dia_semana: 1 } });
    const payload = await current(); payload.grid.from_local = '06:00'; payload.grid.to_local = '23:00';
    const { result } = await grid(payload);
    assert(!at(result, '2030-01-07T05:00:00.000Z')); assert(!at(result, '2030-01-07T19:00:00.000Z'));
    assert(at(result, '2030-01-07T08:00:00.000Z'));
  });
  await check('bounds/siblingfailure/preferencesareexplicitratherthansilentlygreen', async () => {
    const invalid = await current(); invalid.grid.dates = [null]; await assert.rejects(grid(invalid), { code: 'program_grid_invalid' });
    const badSibling = await current(); badSibling.sessions[1].start_at = '2030-01-07T05:00:00Z';
    await assert.rejects(grid(badSibling), { code: 'program_grid_sibling_unavailable' });
    const excluded = await current(); excluded.preferences = { exclude_weekdays: [1] };
    const { result } = await grid(excluded); assert.equal(result.rows[0].slots.length, 0); assert(result.rows[0].unavailable_intervals.length);
  });
  await check('week-All18rooms10doctorsbudgetscompatiblepairsratherthanrejectingconstantdiagnostics', async () => {
    for (let doctor = 4; doctor <= 10; doctor++) {
      await db.Usuario.create({ id_usuario: doctor, nombre: 'Fictitious visible ' + doctor });
      await db.DoctorClinica.create({ doctor_id: doctor, clinica_id: 100, activo: true, recibe_citas: true });
    }
    for (let id = 300; id < 317; id++) await db.Instalacion.create({ id, clinica_id: 100, nombre: 'Fictitious visible ' + id, activo: true });
    const payload = await current(); payload.grid = { dates: Array.from({ length: 7 }, (_, day) => '2030-01-' + String(7 + day).padStart(2, '0')),
      mode: 'installation', column_ids: [101, ...Array.from({ length: 17 }, (_, index) => 300 + index)],
      peer_doctor_ids: Array.from({ length: 10 }, (_, index) => index + 1), from_local: '09:00', to_local: '20:00', granularity_min: 5 };
    const { result, statements } = await grid(payload);
    assert.equal(result.rows.length, 18 * 7); assert(result.rows[0].slots_by_doctor['1'].length);
    assert.equal(result.rows[1].slots_by_doctor['1'].length, 0); assert.equal(result.rows[1].unavailable_by_doctor['1'].length, 1);
    assert(statements.filter(query => /FROM `DoctorClinicas`/.test(query)).length <= 5, 'SQL is bounded by the request, not by cells');
  });
  await check('resumeexcludesonlycanonicalselectedfuturereservationsandpreservesprefix', async () => {
    await f.book({ request_key: 'qa-grid-original-plan', sessions: [0, 1, 2].map(index => ({ key: 's' + index,
      start_at: `2030-01-${String(7 + index).padStart(2, '0')}T09:00:00Z`, selections: {} })) });
    const plan = await f.read(), payload = await current('s1', '2030-01-08');
    Object.assign(payload, { mode: 'resume', replan_from_key: 's1', expected_plan_revision: plan.plan_revision,
      sessions: ['s1', 's2'].map(key => ({ key, placed: false })) });
    const { result, statements } = await grid(payload);
    assert(at(result, '2030-01-08T09:00:00.000Z'));
    const selected = await Promise.all(['s1', 's2'].map(key => f.appointment(key))), prefix = await f.appointment('s0');
    assert(statements.some(query => /NOT IN/.test(query) && selected.every(row => query.includes(String(row.id_cita)))));
    assert(!statements.some(query => /`CitaPaciente`\.`id_cita` NOT IN \([^)]*\)/.test(query)
      && new RegExp('`CitaPaciente`\\.`id_cita` NOT IN \\([^)]*\\b' + prefix.id_cita + '\\b').test(query)));
    await assert.rejects(grid({ ...payload, expected_plan_revision: '0'.repeat(64) }), { code: 'program_resume_changed' });
  });
  await check('rescheduleusescanonicalmovable-suffixandrevisionwithoutchangingbookings', async () => {
    for (const key of ['s1', 's2']) {
      const row = await f.appointment(key); await row.update({ import_metadata: { ...row.import_metadata, automation_policy: 'hold' } });
    }
    const plan = await f.read(), payload = await current('s1', '2030-01-08');
    Object.assign(payload, { mode: 'reschedule', reschedule_scope: 'following', replan_from_key: 's1', expected_plan_revision: plan.plan_revision,
      sessions: ['s1', 's2'].map(key => ({ key, placed: false })) });
    assert(at((await grid(payload)).result, '2030-01-08T09:00:00.000Z'));
    await assert.rejects(grid({ ...payload, sessions: [{ key: 's0', placed: false }] }), { code: 'program_grid_sessions_invalid' });
  });
  report.programAgendaAvailability = { passed: checks.length, checks, sqlIsReal: true, gridDmlStatements: 0,
    limits: ['HTTP ACL is exercised separately; fixture capabilities are explicit, and no provider/worker is loaded'] };
  console.log(JSON.stringify(report.programAgendaAvailability));
});
