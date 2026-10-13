'use strict';

// Opt-in OWNED MySQL only. No configured DEV/CRM connection, live API/session,
// provider or historical row is ever used. The launcher owns the process,
// datadir, Unix socket, database and registered loopback server; denies all
// other sockets/fetch/queues; and stops its own mysqld after read-back evidence.
// CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 INSTALLATION_PHYSICAL_SHARING_MYSQL_TEST=1 node --test THIS_FILE
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');

const DAY = '2030-01-07';
const EXTRA = Object.freeze({ thirdClinic: 300, unrelatedClinic: 400, unrelatedGroup: 60,
  peerDoctor: 91100, peerAlternativeDoctor: 91101, peerRoom: 94201,
  rootTreatment: 93100, peerTreatment: 93200, unlinkedRoom: 94300,
  raceRoot: 96301, racePeer: 96302, raceTreatment: 95302 });
const copy = value => JSON.parse(JSON.stringify(value));
const iso = value => new Date(value).toISOString();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const barrier = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const projection = slot => ({ start_at: iso(slot.start_at), end_at: iso(slot.end_at),
  phases: slot.phases.map(phase => ({ key: phase.key, installation_id: phase.installation_id, doctor_ids: phase.doctor_ids })) });
const url = (pathname, values) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) for (const item of Array.isArray(value) ? value : [value]) query.append(key, String(item));
  return pathname + '?' + query;
};

test('shared physical room: native authenticated HTTP, SQL scopes, complete availability and both transaction-lock races',
  { skip: process.env.INSTALLATION_PHYSICAL_SHARING_MYSQL_TEST !== '1', timeout: 240000 }, async () => {
    await withIsolatedCampaignMysql(async owned => {
      // These flags are process-local, fictitious, and never persisted to a
      // real application configuration. Auth helper also replaces dotenv.
      process.env.AVAILABILITY_REALTIME_ENABLED = 'false';
      process.env.BOOKING_EQUIPMENT_ENABLED = 'false';
      const f = await createOwnedVisitAuthAclFixture({ ...owned,
        includeAvailabilityRoutes: true, includeInstallationRoutes: true, nativeFinalHandler: true });
      const { db, sql, ids, request } = f;
      const { report } = owned;
      const { Op } = S;
      const booking = require('../../services/appointmentBookingCommand.service');
      const availability = require('../../services/appointmentBookingAvailability.service');
      const solver = require('../../lib/booking-profile-solver');
      const capabilities = { simple: true, multi: true, relativeSteps: true, equipment: false };
      const tables = ['Instalacion', 'InstalacionHorario', 'InstalacionBloqueo', 'InstallationPhysicalAlias',
        'DoctorClinica', 'DoctorHorario', 'Clinica', 'ClinicaHorario', 'Tratamiento', 'Paciente', 'PacienteClinica',
        'CitaPaciente', 'AppointmentBookingOccupancy', 'AppointmentBookingResource'];
      const fingerprint = async () => {
        const snapshots = {};
        for (const name of tables) snapshots[name] = await db[name].findAll({
          order: db[name].primaryKeyAttributes.map(key => [key, 'ASC']), raw: true });
        return crypto.createHash('sha256').update(JSON.stringify(snapshots)).digest('hex');
      };
      const sideEffects = async () => {
        const counts = {};
        for (const name of ['Message', 'JobRequest', 'FlowExecutionV2', 'Notification', 'PatientConsentDocument']) counts[name] = await db[name].count();
        assert.deepEqual(counts, { Message: 0, JobRequest: 0, FlowExecutionV2: 0, Notification: 0, PatientConsentDocument: 0 });
        assert.equal(f.externalFetchAttempts, 0); return counts;
      };
      const login = async actor => {
        const challenge = await request('POST', '/api/auth/sign-in', { email: `owned-${actor}@example.invalid`, password: f.password });
        assert.equal(challenge.status, 202);
        const contract = require('../../services/authEmailChallenge.contract');
        const row = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: contract.challengeHash(challenge.body.challengeToken) } });
        const accepted = await request('POST', '/api/auth/email-code/verify', {
          challengeToken: challenge.body.challengeToken, code: f.codeFor(row.challenge_id) });
        assert.equal(accepted.status, 200); return accepted.body.token;
      };
      let owner, outsider, reception;
      const get = async target => {
        const result = await request('GET', target, undefined, owner);
        assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
      };
      const rejected = async (method, target, body, { token = owner, status, code } = {}) => {
        const before = await fingerprint(), result = await request(method, target, body, token);
        if (Array.isArray(status)) assert(status.includes(result.status), JSON.stringify(result.body));
        else if (status) assert.equal(result.status, status, JSON.stringify(result.body));
        else assert(result.status >= 400, JSON.stringify(result.body));
        if (code) assert.equal(result.body.code, code, JSON.stringify(result.body));
        assert.match(result.headers['content-type'], /^application\/json\b/);
        assert.deepEqual(await fingerprint(), before, 'Rejected native request changes no room, clinical, assignment or reservation rows');
        return result;
      };
      const profile = (room, doctor) => ({ version: 1, phases: [{ key: 'care', label: 'OWNED synthetic care', duration_minutes: 30,
        installation_ids: [room], professionals: { mode: 'any', ids: [doctor], preferred_id: doctor } }] });
      const createRoom = async (id, clinic, doctors) => {
        await db.Instalacion.create({ id, clinica_id: clinic, nombre: 'OWNED C3 synthetic ' + id,
          activo: true, capacidad: 1, profesionales_permitidos: doctors });
        await db.InstalacionHorario.bulkCreate(Array.from({ length: 7 }, (_, day) => ({ instalacion_id: id,
          dia_semana: day, activo: true, hora_inicio: '00:00', hora_fin: '23:59' })));
      };
      const createTreatment = (id, clinic, room, doctor) => db.Tratamiento.create({ id_tratamiento: id,
        clinica_id: clinic, grupo_clinica_id: ids.group, nombre: 'OWNED fixed30 synthetic ' + id,
        origen: 'clinica', disciplina: 'medicina', activo: true, precio_base: 0, eliminado_por_clinica: [],
        clinical_config: { catalog_status: 'active', booking_profile: profile(room, doctor) } });
      const appointment = ({ clinic = ids.clinic, patient = ids.patient, treatment = EXTRA.rootTreatment,
        room = ids.roomOne, doctor = ids.doctorOne, start = '2030-01-07T09:00:00Z' } = {}) => ({
        clinica_id: clinic, tratamiento_id: treatment, doctor_id: doctor, instalacion_id: room,
        inicio: start, fin: new Date(Date.parse(start) + 30 * 60000).toISOString(), estado: 'pendiente',
        tipo_cita: 'continuacion', paciente: { id_paciente: patient }, same_day_choice: { mode: 'separate' },
      });
      const reserveNative = body => request('POST', '/api/citas', body, owner);
      const reserveCommand = (body, transaction = undefined) => {
        const { paciente, same_day_choice, ...values } = body;
        return booking.mutateAppointmentBooking({ db, capabilities, transaction,
          appointmentValues: { ...values, paciente_id: paciente.id_paciente, created_by: ids.owner },
          persist: ({ values, transaction }) => db.CitaPaciente.create(values, { transaction }) });
      };
      const sharing = async room => {
        const context = await get(`/api/instalaciones/${room}/sharing`);
        return { revision: context.revision, memberships: copy(context.memberships) };
      };
      const evidence = async id => ({ appointment: await db.CitaPaciente.findByPk(id, { raw: true }),
        occupancy: await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: id }, order: [['id', 'ASC']], raw: true }) });
      const waitForLock = async (threadId, expectedMode, blockerThreadId) => {
        assert(Number.isSafeInteger(threadId) && threadId > 0, 'Contender must be a real OWNED MySQL connection ID');
        assert(Number.isSafeInteger(blockerThreadId) && blockerThreadId > 0, 'Holder must be a real OWNED MySQL connection ID');
        const deadline = Date.now() + 8000;
        let observed = [], lockRows = [];
        while (Date.now() < deadline) {
          const [rows] = await sql.query('SELECT trx_mysql_thread_id, trx_state FROM INFORMATION_SCHEMA.INNODB_TRX');
          observed = rows;
          // SHOW ENGINE can omit a read-only waiter before its first DML.
          // Performance-schema witnesses both ends of the CURRENT native
          // record-lock edge, mapped to exact OWNED MySQL connection IDs.
          // Do not select SQL text, lock IDs or LOCK_DATA/record contents.
          const [locks] = await sql.query(`SELECT requester.PROCESSLIST_ID AS requesting_thread_id,
            blocker.PROCESSLIST_ID AS blocking_thread_id,
            requested.OBJECT_SCHEMA AS schema_name, requested.OBJECT_NAME AS table_name,
            requested.INDEX_NAME AS index_name, requested.LOCK_TYPE AS lock_type,
            requested.LOCK_MODE AS requested_mode, requested.LOCK_STATUS AS requested_status,
            held.OBJECT_SCHEMA AS blocking_schema_name, held.OBJECT_NAME AS blocking_table_name,
            held.INDEX_NAME AS blocking_index_name, held.LOCK_TYPE AS blocking_lock_type,
            held.LOCK_MODE AS blocking_mode, held.LOCK_STATUS AS blocking_status
            FROM performance_schema.data_lock_waits AS waits
            JOIN performance_schema.data_locks AS requested ON requested.ENGINE = waits.ENGINE
              AND requested.ENGINE_LOCK_ID = waits.REQUESTING_ENGINE_LOCK_ID
            JOIN performance_schema.data_locks AS held ON held.ENGINE = waits.ENGINE
              AND held.ENGINE_LOCK_ID = waits.BLOCKING_ENGINE_LOCK_ID
            JOIN performance_schema.threads AS requester ON requester.THREAD_ID = waits.REQUESTING_THREAD_ID
            JOIN performance_schema.threads AS blocker ON blocker.THREAD_ID = waits.BLOCKING_THREAD_ID
            WHERE requester.PROCESSLIST_ID = :threadId AND blocker.PROCESSLIST_ID = :blockerThreadId`,
          { replacements: { threadId, blockerThreadId } });
          lockRows = locks;
          const recordWait = locks.find(lock => lock.schema_name === 'campaign_optimization_qa'
            && lock.table_name === 'Clinicas' && lock.index_name === 'PRIMARY' && lock.lock_type === 'RECORD'
            && String(lock.requested_mode).split(',')[0] === expectedMode && lock.requested_status === 'WAITING'
            && lock.blocking_schema_name === 'campaign_optimization_qa' && lock.blocking_table_name === 'Clinicas'
            && lock.blocking_index_name === 'PRIMARY' && lock.blocking_lock_type === 'RECORD'
            && String(lock.blocking_mode).split(',')[0] === (expectedMode === 'X' ? 'S' : 'X')
            && lock.blocking_status === 'GRANTED');
          if (recordWait) {
            report.native_lock_wait_witnesses ||= [];
            report.native_lock_wait_witnesses.push({ thread_id: threadId, state: 'LOCK WAIT',
              source: 'PERFORMANCE_SCHEMA_NATIVE_RECORD_LOCK_EDGE', table: 'Clinicas', index: 'PRIMARY', mode: expectedMode,
              blocker_thread_id: blockerThreadId, blocking_mode: recordWait.blocking_mode,
              information_schema_state: rows.find(row => Number(row.trx_mysql_thread_id) === threadId)?.trx_state || null });
            return;
          }
          await wait(300);
        }
        const [processes] = await sql.query('SELECT ID, COMMAND, STATE FROM INFORMATION_SCHEMA.PROCESSLIST WHERE DB = DATABASE()');
        report.lock_wait_diagnostic = { expected_thread_id: threadId, expected_mode: expectedMode,
          expected_blocker_thread_id: blockerThreadId, observed_transactions: observed, locks: lockRows, processes };
        assert.fail('The OWNED contender must reach a native InnoDB LOCK WAIT: ' + JSON.stringify(report.lock_wait_diagnostic));
      };
      try {
        await db.GrupoClinica.create({ id_grupo: EXTRA.unrelatedGroup, nombre: 'OWNED unrelated synthetic group' });
        await db.Clinica.bulkCreate([
          { id_clinica: EXTRA.thirdClinic, grupoClinicaId: ids.group, nombre_clinica: 'OWNED third synthetic clinic', configuracion: { timezone: 'Europe/Madrid' } },
          { id_clinica: EXTRA.unrelatedClinic, grupoClinicaId: EXTRA.unrelatedGroup, nombre_clinica: 'OWNED unrelated synthetic clinic', configuracion: { timezone: 'Europe/Madrid' } },
        ]);
        await db.UsuarioClinica.bulkCreate([ids.peerClinic, EXTRA.thirdClinic, EXTRA.unrelatedClinic].map(id_clinica => ({
          id_usuario: ids.owner, id_clinica, rol_clinica: 'propietario', estado_invitacion: 'aceptada' })));
        await db.Usuario.bulkCreate([EXTRA.peerDoctor, EXTRA.peerAlternativeDoctor].map(id_usuario => ({
          id_usuario, nombre: 'OWNED peer-only synthetic doctor', apellidos: String(id_usuario),
          email_usuario: `owned-${id_usuario}@example.invalid`, estado_cuenta: 'activo' })));
        for (const doctor_id of [EXTRA.peerDoctor, EXTRA.peerAlternativeDoctor]) {
          const dc = await db.DoctorClinica.create({ doctor_id, clinica_id: ids.peerClinic, activo: true, recibe_citas: true });
          await db.DoctorHorario.bulkCreate(Array.from({ length: 7 }, (_, day) => ({ doctor_clinica_id: dc.id,
            dia_semana: day, activo: true, hora_inicio: '00:00', hora_fin: '23:59' })));
        }
        await db.Instalacion.update({ profesionales_permitidos: [ids.doctorOne] }, { where: { id: ids.roomOne } });
        await createRoom(EXTRA.peerRoom, ids.peerClinic, [EXTRA.peerDoctor]);
        await db.InstallationPhysicalAlias.create({ installation_id: EXTRA.peerRoom, canonical_installation_id: ids.roomOne, group_id: ids.group });
        await createRoom(EXTRA.unlinkedRoom, ids.peerClinic, [EXTRA.peerDoctor]);
        await createRoom(EXTRA.raceRoot, ids.clinic, [ids.doctorOne]);
        await createRoom(EXTRA.racePeer, ids.peerClinic, [EXTRA.peerDoctor, EXTRA.peerAlternativeDoctor]);
        await db.InstallationPhysicalAlias.create({ installation_id: EXTRA.racePeer, canonical_installation_id: EXTRA.raceRoot, group_id: ids.group });
        await createTreatment(EXTRA.rootTreatment, ids.clinic, ids.roomOne, ids.doctorOne);
        await createTreatment(EXTRA.peerTreatment, ids.peerClinic, EXTRA.peerRoom, EXTRA.peerDoctor);
        await createTreatment(EXTRA.raceTreatment, ids.peerClinic, EXTRA.racePeer, EXTRA.peerDoctor);
        owner = await login(ids.owner); outsider = await login(ids.outsider); reception = await login(ids.reception);
        await sideEffects();

        const rootContext = await get(`/api/instalaciones/${ids.roomOne}/sharing`);
        assert.equal(rootContext.canonical_installation_id, ids.roomOne); assert.equal(rootContext.sharing_enabled, true);
        assert.deepEqual(rootContext.memberships.map(row => [row.clinic_id, row.installation_id]), [[ids.clinic, ids.roomOne], [ids.peerClinic, EXTRA.peerRoom]]);
        assert(!rootContext.clinics.find(row => row.clinic_id === ids.clinic).professionals.some(row => row.doctor_id === EXTRA.peerDoctor));
        assert(rootContext.clinics.find(row => row.clinic_id === ids.peerClinic).professionals.some(row => row.doctor_id === EXTRA.peerDoctor));
        assert(!rootContext.clinics.some(row => row.clinic_id === EXTRA.unrelatedClinic));
        const ownList = await get(url('/api/instalaciones', { clinica_id: ids.clinic }));
        assert.deepEqual(ownList.find(row => row.id === ids.roomOne).physical_sharing_clinics.map(row => row.clinic_id), [ids.clinic, ids.peerClinic]);
        const hidden = await request('GET', `/api/instalaciones/${EXTRA.peerRoom}/sharing`, undefined, outsider);
        assert.equal(hidden.status, 200); assert.equal(hidden.body.canonical_installation_id, null);
        assert.equal(hidden.body.can_configure, false); assert.deepEqual(hidden.body.memberships.map(row => row.installation_id), [EXTRA.peerRoom]);
        assert(!hidden.body.clinics.some(row => row.clinic_id !== ids.peerClinic));
        await rejected('GET', `/api/instalaciones/${ids.roomOne}/sharing`, undefined, { token: outsider, status: 403 });
        await rejected('PUT', `/api/instalaciones/${EXTRA.peerRoom}`, { nombre: 'not allowed' }, { token: outsider, status: 403 });
        await rejected('GET', '/api/instalaciones/sharing-context?clinica_id=1e2', undefined, { status: 400 });
        await rejected('PUT', `/api/instalaciones/${ids.roomOne}`, { physical_sharing: { revision: 'a'.repeat(64), memberships: {} } },
          { status: 400, code: 'installation_sharing_invalid' });
        const invalidGroup = await sharing(ids.roomOne);
        invalidGroup.memberships.push({ clinic_id: EXTRA.unrelatedClinic, installation_id: null, enabled: true, professional_mode: 'all', professional_ids: [] });
        await rejected('PUT', `/api/instalaciones/${ids.roomOne}`, { physical_sharing: invalidGroup },
          { status: 403, code: 'installation_sharing_forbidden' });
        report.checks.push('Native JWT + email MFA + real clinic/role ACL and sharing routes: visible/current clinic membership is exact; peer-only professionals never borrow another clinic; hidden physical reference is NULL; unrelated group, unauthorized edit and malformed DTO/ID reject without domain writes.');

        const peerBeforeOrdinary = await db.Instalacion.findByPk(EXTRA.peerRoom, { raw: true });
        const ownOrdinary = await request('PUT', `/api/instalaciones/${ids.roomOne}`, { nombre: 'OWNED own-clinic member edit',
          profesionales_permitidos: [ids.doctorOne, ids.doctorTwo], capacidad: 1,
          allow_overlap_confirmation: false, overlap_capacity_unlimited: false }, reception);
        assert.equal(ownOrdinary.status, 200, JSON.stringify(ownOrdinary.body));
        assert.deepEqual(await db.Instalacion.findByPk(EXTRA.peerRoom, { raw: true }), peerBeforeOrdinary);
        await rejected('PUT', `/api/instalaciones/${ids.roomOne}`, { nombre: 'not authorized across clinics', capacidad: 2 },
          { token: reception, status: 403 });
        report.checks.push('Native restricted reception actor can edit own member name/professionals while echoing unchanged normalized capacity without touching the peer. A real shared-capacity change still requires peer edit authority and rolls back the ordinary fields.');

        const draft = await get(url('/api/instalaciones/sharing-context', { clinica_id: ids.clinic }));
        assert.deepEqual(draft.memberships, [{ clinic_id: ids.clinic, installation_id: null,
          enabled: true, professional_mode: 'all', professional_ids: [] }]);
        const draftBody = { clinica_id: ids.clinic, nombre: 'OWNED new shared C4', tipo: 'consulta',
          horarios: Array.from({ length: 7 }, (_, day) => ({ dia_semana: day, activo: true, hora_inicio: '09:00', hora_fin: '18:00' })),
          physical_sharing: { revision: draft.revision, memberships: [...draft.memberships,
            { clinic_id: ids.peerClinic, installation_id: null, enabled: true, professional_mode: 'selected', professional_ids: [EXTRA.peerDoctor] }] } };
        const oldDoctorLinks = await db.DoctorClinica.findAll({ order: [['id', 'ASC']], raw: true });
        const createdRoom = await request('POST', '/api/instalaciones', draftBody, owner);
        assert.equal(createdRoom.status, 201, JSON.stringify(createdRoom.body));
        const newAlias = await db.InstallationPhysicalAlias.findOne({ where: { canonical_installation_id: createdRoom.body.id }, raw: true });
        assert(newAlias); assert.equal((await db.Instalacion.findByPk(newAlias.installation_id)).clinica_id, ids.peerClinic);
        assert.deepEqual(await db.DoctorClinica.findAll({ order: [['id', 'ASC']], raw: true }), oldDoctorLinks);
        const sourceHours = await db.InstalacionHorario.findAll({ where: { instalacion_id: createdRoom.body.id }, raw: true });
        const targetHours = await db.InstalacionHorario.findAll({ where: { instalacion_id: newAlias.installation_id }, raw: true });
        assert(sourceHours.every(row => row.hora_inicio === '09:00')); assert(targetHours.every(row => row.hora_inicio === '00:00'));
        assert.equal(sourceHours.length, 7); assert.equal(targetHours.length, 7);
        const rollbackDraft = await get(url('/api/instalaciones/sharing-context', { clinica_id: ids.clinic }));
        db.InstallationPhysicalAlias.addHook('beforeCreate', 'owned-sharing-insert-failure', () => { throw Error('OWNED simulated alias INSERT failure'); });
        try {
          await rejected('POST', '/api/instalaciones', { ...draftBody, nombre: 'OWNED rollback C5',
            physical_sharing: { ...draftBody.physical_sharing, revision: rollbackDraft.revision } }, { status: 500 });
        } finally { db.InstallationPhysicalAlias.removeHook('beforeCreate', 'owned-sharing-insert-failure'); }

        const freeContext = await get(`/api/instalaciones/${ids.roomTwo}/sharing`);
        const candidate = freeContext.clinics.find(row => row.clinic_id === ids.peerClinic).installations.find(row => row.installation_id === EXTRA.unlinkedRoom);
        assert.equal(candidate.can_link, true); assert.deepEqual(candidate.professional_ids, [EXTRA.peerDoctor]);
        const freeLink = await request('PUT', `/api/instalaciones/${ids.roomTwo}`, { physical_sharing: { revision: freeContext.revision,
          memberships: [...freeContext.memberships, { clinic_id: ids.peerClinic, installation_id: candidate.installation_id,
            enabled: true, professional_mode: candidate.professional_mode, professional_ids: candidate.professional_ids }] } }, owner);
        assert.equal(freeLink.status, 200, JSON.stringify(freeLink.body));
        assert.equal((await db.InstallationPhysicalAlias.findByPk(EXTRA.unlinkedRoom)).canonical_installation_id, ids.roomTwo);
        assert.deepEqual((await db.Instalacion.findByPk(EXTRA.unlinkedRoom)).profesionales_permitidos, [EXTRA.peerDoctor]);
        report.checks.push('Native POST draft creates two clinical members and one physical link atomically with separate clinic hours and no DoctorClinica enrollment; injected real alias INSERT failure rolls back both rooms and schedules. Explicit free existing-room selection preserves its original ID and professional allowlist.');

        const digestBeforePreview = await fingerprint();
        const profileRoot = profile(ids.roomOne, ids.doctorOne), clinic = await db.Clinica.findByPk(ids.clinic);
        const context = await availability.loadBookingContext({ db, clinic, profile: profileRoot,
          start: new Date('2030-01-06T23:00:00Z'), end: new Date('2030-01-07T23:00:00Z'), occupancyEnabled: true, equipmentEnabled: false });
        // Independent strict enumeration: do not use the slot-search wrapper
        // itself as the oracle. Explicit room/staff search also returns marked
        // restriction proposals, which are not ordinary available positions.
        const canonical = [];
        const { resolveLocalInstant } = require('../../lib/voucher-schedule-calendar');
        for (let minute = 0; minute < 1440; minute += 30) {
          const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`;
          const start = resolveLocalInstant(DAY, time, context.timeZone);
          const solution = solver.solveBookingProfile({ profile: profileRoot, start, ...context,
            selections: { care: { doctor_id: ids.doctorOne, installation_id: ids.roomOne } } });
          if (solution) canonical.push(solution);
        }
        const query = { clinica_id: ids.clinic, tratamiento_id: EXTRA.rootTreatment, fecha_local: DAY,
          doctor_id: ids.doctorOne, instalacion_id: ids.roomOne, duracion_min: 30, granularity_min: 30, limit: 500 };
        const proposals = await get(url('/api/disponibilidad/treatment-slots', query));
        const slots = await get(url('/api/disponibilidad/slots', query));
        const grid = await get(url('/api/disponibilidad/grid', { ...query, mode: 'installation', dates: [DAY],
          column_ids: [ids.roomOne], context_doctor_id: ids.doctorOne }));
        const summary = await get(url('/api/disponibilidad/summary', { ...query, mode: 'installation', dates: [DAY],
          column_ids: [ids.roomOne], context_doctor_id: ids.doctorOne }));
        assert.equal(proposals.duration_minutes, 30); assert.equal(slots.duracion_min, 30);
        assert.deepEqual(proposals.slots.filter(slot => slot.requires_restriction_acknowledgement !== true).map(projection), canonical.map(projection));
        assert.deepEqual(slots.slots.map(projection), canonical.map(projection));
        assert.equal(grid.rows[0].ok, true); assert.deepEqual(grid.rows[0].slots.map(projection), canonical.map(projection));
        assert.equal(summary.by_day[DAY], true);
        const available = await get(url('/api/disponibilidad/check', { ...query, inicio_local: DAY + 'T10:00', fin_local: DAY + 'T10:30' }));
        assert.equal(available.available, true); assert.equal(available.booking.end_at, '2030-01-07T09:30:00.000Z');
        assert.equal(await fingerprint(), digestBeforePreview);
        assert(solver.solveBookingProfile({ profile: profileRoot, start: '2030-01-07T09:00:00Z', ...context }));
        const late = proposals.slots.find(slot => slot.start_at === '2030-01-07T22:30:00.000Z');
        assert(late); assert.equal(late.end_at, '2030-01-07T23:00:00.000Z');
        assert.equal(late.requires_restriction_acknowledgement, true);
        assert(late.booking_restrictions.some(row => /_OUT_OF_HOURS$/.test(row.code)));
        assert(!slots.slots.some(slot => slot.start_at === late.start_at));
        assert(grid.rows[0].unavailable_intervals.some(row => Date.parse(row.start_utc) <= Date.parse(late.start_at)
          && Date.parse(late.start_at) < Date.parse(row.end_utc)));
        await rejected('GET', url('/api/disponibilidad/check', { ...query, inicio_local: DAY + 'T23:30', fin_local: '2030-01-08T00:00' }),
          undefined, { status: 409, code: 'booking_restriction_confirmation_required' });
        await rejected('POST', '/api/citas', appointment({ start: late.start_at }),
          { status: 409, code: 'booking_restriction_confirmation_required' });
        report.checks.push('Native SQL check/treatment-slots/slots/grid/summary ordinary positions equal independent strict solver enumeration at every30-minute start, without GET writes. 23:30–24:00 exceeds stored23:59: explicit-selection search marks a complete30-minute restriction proposal, grid marks it unavailable, and check/create cannot silently save it without the real restriction receipt.');

        const nativeRace = await Promise.all([
          reserveNative(appointment()),
          reserveNative(appointment({ clinic: ids.peerClinic, patient: ids.foreignPatient,
            treatment: EXTRA.peerTreatment, room: EXTRA.peerRoom, doctor: EXTRA.peerDoctor })),
        ]);
        assert.equal(nativeRace.filter(row => row.status === 201).length, 1, JSON.stringify(nativeRace.map(row => row.body)));
        const deniedRace = nativeRace.find(row => row.status !== 201);
        assert.equal(deniedRace.status, 409); assert.equal(deniedRace.body.can_force, false);
        const winner = nativeRace.find(row => row.status === 201).body;
        const reserved = await evidence(winner.id_cita);
        assert(reserved.occupancy.some(row => row.resource_key === `installation:${ids.roomOne}`));
        assert.equal(reserved.appointment.instalacion_id, winner.instalacion_id);
        const other = nativeRace[0].status === 201 ? appointment({ clinic: ids.peerClinic, patient: ids.foreignPatient,
          treatment: EXTRA.peerTreatment, room: EXTRA.peerRoom, doctor: EXTRA.peerDoctor }) : appointment();
        await rejected('POST', '/api/citas', { ...other, force: true }, { status: 409 });
        await rejected('POST', '/api/citas', { ...appointment({ start: '2030-01-07T12:00:00Z' }), clinica_id: [ids.clinic, ids.peerClinic] }, { status: 400 });
        await rejected('POST', '/api/citas', appointment({ doctor: EXTRA.peerDoctor, start: '2030-01-07T12:00:00Z' }), { status: [400,409] });
        assert.equal(await db.DoctorClinica.count({ where: { clinica_id: ids.clinic, doctor_id: EXTRA.peerDoctor } }), 0);
        const groupCalendar = await get(url('/api/citas/calendar', { clinica_id: `${ids.clinic},${ids.peerClinic}`,
          startDate: DAY, endDate: '2030-01-08' }));
        assert(groupCalendar.some(row => row.id_cita === winner.id_cita));
        const displayed = groupCalendar.find(row => row.id_cita === winner.id_cita);
        assert.deepEqual(displayed.agenda_installation_aliases[ids.roomOne].map(Number).sort((a,b)=>a-b), [ids.roomOne, EXTRA.peerRoom]);
        assert.equal(displayed.clinica_id, winner.clinica_id); assert.equal(displayed.instalacion_id, winner.instalacion_id);
        assert.deepEqual(await evidence(winner.id_cita), reserved);
        report.checks.push('Two native authenticated writers on distinct clinical room IDs compete on one InnoDB physical anchor: one201 and one409; force cannot bypass a foreign-clinic booking. Calendar group display adds explicit aliases without rewriting booking IDs/snapshots; group arrays cannot mutate a single clinic and peer staff are not auto-enrolled.');

        const stale = await sharing(ids.roomOne);
        const rename = await request('PUT', `/api/instalaciones/${ids.roomOne}`, { nombre: 'OWNED renamed physical member', physical_sharing: stale }, owner);
        assert.equal(rename.status, 200, JSON.stringify(rename.body));
        await rejected('PUT', `/api/instalaciones/${ids.roomOne}`, { nombre: 'not the fresh version', physical_sharing: stale },
          { status: 409, code: 'installation_sharing_stale' });
        assert.deepEqual(await evidence(winner.id_cita), reserved);
        const withdraw = await sharing(winner.instalacion_id === ids.roomOne ? EXTRA.peerRoom : ids.roomOne);
        withdraw.memberships.find(row => row.installation_id === winner.instalacion_id).enabled = false;
        const otherEditor = winner.instalacion_id === ids.roomOne ? EXTRA.peerRoom : ids.roomOne;
        await rejected('PUT', `/api/instalaciones/${otherEditor}`, { physical_sharing: withdraw },
          { status: 409, code: 'installation_sharing_review_required' });
        const linkRoot = await sharing(ids.roomTwo);
        linkRoot.memberships.push({ clinic_id: ids.peerClinic, installation_id: EXTRA.peerRoom, enabled: true,
          professional_mode: 'selected', professional_ids: [EXTRA.peerDoctor] });
        await rejected('PUT', `/api/instalaciones/${ids.roomTwo}`, { physical_sharing: linkRoot },
          { status: 400, code: 'installation_sharing_invalid' });
        report.checks.push('Native compound save preserves canonical/reference/appointment/occupancy; stale revisions and withdrawing a clinic with a future booking reject atomically. A member already linked elsewhere cannot be selected as a new alias.');

        // Real booking wins first: its SHARE clinic lock makes the attempted
        // withdrawal wait, then the committed future booking vetoes the save.
        const hold = await sql.transaction({ isolationLevel: 'READ COMMITTED' });
        const blocker = barrier(); let shareThread, withdrawalResult;
        const previousLogging = sql.options.logging;
        sql.options.logging = statement => {
          if (/FROM `Clinicas` AS `Clinica`/.test(statement) && /FOR UPDATE|LOCK IN SHARE MODE/.test(statement)) {
            report.clinic_lock_statements ||= [];
            report.clinic_lock_statements.push({ clinic_id: Number(/`Clinica`\.`id_clinica` = (\d+)/.exec(statement)?.[1]) || null,
              mode: /FOR UPDATE/.test(statement) ? 'UPDATE' : 'SHARE' });
          }
          if (typeof previousLogging === 'function') previousLogging(statement);
        };
        db.Clinica.addHook('beforeFind', 'owned-sharing-waiter', async options => {
          if (options.lock === 'UPDATE' && options.transaction !== hold) {
            await sql.query('SET SESSION innodb_lock_wait_timeout = 15', { transaction: options.transaction });
            const [[connection]] = await sql.query('SELECT CONNECTION_ID() AS id', { transaction: options.transaction });
            shareThread = Number(connection.id);
            report.sharing_waiter_connections ||= []; report.sharing_waiter_connections.push({ actual: shareThread,
              driver: options.transaction.connection.threadId, clinic: options.where?.id_clinica });
            blocker.resolve();
          }
        });
        try {
          const pending = await reserveCommand(appointment({ clinic: ids.peerClinic, patient: ids.foreignPatient,
            treatment: EXTRA.peerTreatment, room: EXTRA.peerRoom, doctor: EXTRA.peerDoctor, start: '2030-01-08T09:00:00Z' }), hold);
          const [[holder]] = await sql.query('SELECT CONNECTION_ID() AS id', { transaction: hold });
          report.booking_holder_connection = Number(holder.id);
          const plan = await sharing(ids.roomOne); plan.memberships.find(row => row.clinic_id === ids.peerClinic).enabled = false;
          withdrawalResult = request('PUT', `/api/instalaciones/${ids.roomOne}`, { physical_sharing: plan }, owner)
            .then(result => { report.sharing_waiter_result = { status: result.status, code: result.body?.code }; return result; });
          await blocker.promise; await waitForLock(shareThread, 'X', Number(holder.id));
          await hold.commit();
          const result = await withdrawalResult;
          assert.equal(result.status, 409, JSON.stringify(result.body)); assert.equal(result.body.code, 'installation_sharing_review_required');
          assert.equal((await db.Instalacion.findByPk(EXTRA.peerRoom)).activo, true);
          assert((await evidence(pending.id_cita)).occupancy.some(row => row.resource_key === `installation:${ids.roomOne}`));
        } finally {
          db.Clinica.removeHook('beforeFind', 'owned-sharing-waiter');
          if (!hold.finished) await hold.rollback(); if (withdrawalResult) await withdrawalResult;
          sql.options.logging = previousLogging;
        }
        report.checks.push('Real InnoDB LOCK WAIT observed for sharing UPDATE against pending booking SHARE; after booking commit the save reads the new future reservation and rolls back clinic withdrawal, without changing its canonical physical key.');

        // Real sharing wins first: hold inside native HTTP's UPDATE hook after
        // taking clinic/resource locks. A strict booking then must wait and
        // re-read the newly narrowed room permission instead of a stale slot.
        const entered = barrier(), release = barrier(), bookingWaiting = barrier();
        let bookingThread, sharingThread, bookingResult, saving;
        db.Instalacion.addHook('beforeUpdate', 'owned-sharing-hold', async (row, options) => {
          if (row.id === EXTRA.raceRoot && row.nombre === 'OWNED sharing lock witness') {
            const [[connection]] = await sql.query('SELECT CONNECTION_ID() AS id', { transaction: options.transaction });
            sharingThread = Number(connection.id); entered.resolve(); await release.promise;
          }
        });
        db.Clinica.addHook('beforeFind', 'owned-booking-waiter', async options => {
          if (options.lock === 'SHARE' && options.where?.id_clinica === ids.peerClinic) {
            await sql.query('SET SESSION innodb_lock_wait_timeout = 15', { transaction: options.transaction });
            const [[connection]] = await sql.query('SELECT CONNECTION_ID() AS id', { transaction: options.transaction });
            bookingThread = Number(connection.id); bookingWaiting.resolve();
          }
        });
        try {
          const plan = await sharing(EXTRA.raceRoot);
          plan.memberships.find(row => row.clinic_id === ids.peerClinic).professional_ids = [EXTRA.peerAlternativeDoctor];
          saving = request('PUT', `/api/instalaciones/${EXTRA.raceRoot}`, { nombre: 'OWNED sharing lock witness', physical_sharing: plan }, owner);
          await entered.promise;
          bookingResult = reserveCommand(appointment({ clinic: ids.peerClinic, patient: ids.foreignPatient,
            treatment: EXTRA.raceTreatment, room: EXTRA.racePeer, doctor: EXTRA.peerDoctor, start: '2030-01-09T09:00:00Z' }))
            .then(value => ({ value }), error => ({ error }));
          await bookingWaiting.promise; await waitForLock(bookingThread, 'S', sharingThread); release.resolve();
          const saved = await saving; assert.equal(saved.status, 200, JSON.stringify(saved.body));
          const attempt = await bookingResult; assert.equal(attempt.error?.code, 'booking_unavailable');
          assert.deepEqual((await db.Instalacion.findByPk(EXTRA.racePeer)).profesionales_permitidos, [EXTRA.peerAlternativeDoctor]);
          assert.equal(await db.CitaPaciente.count({ where: { instalacion_id: EXTRA.racePeer } }), 0);
          assert.equal(await db.InstallationPhysicalAlias.count({ where: { installation_id: EXTRA.racePeer,
            canonical_installation_id: EXTRA.raceRoot } }), 1);
        } finally {
          release.resolve(); db.Instalacion.removeHook('beforeUpdate', 'owned-sharing-hold');
          db.Clinica.removeHook('beforeFind', 'owned-booking-waiter'); if (saving) await saving; if (bookingResult) await bookingResult;
        }
        report.checks.push('Reverse real InnoDB LOCK WAIT: booking SHARE waits for native sharing UPDATE; after commit the strict command observes the narrowed clinic-local allowlist and refuses the old professional without an appointment. Physical alias key is unchanged.');

        const inactivePlan = await sharing(EXTRA.racePeer);
        inactivePlan.memberships.find(row => row.installation_id === EXTRA.raceRoot).enabled = false;
        const disabled = await request('PUT', `/api/instalaciones/${EXTRA.racePeer}`, { physical_sharing: inactivePlan }, owner);
        assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
        const inactiveAlias = await db.InstallationPhysicalAlias.findByPk(EXTRA.racePeer);
        assert.equal(inactiveAlias.canonical_installation_id, EXTRA.raceRoot);
        const mapping = await availability.resolveInstallationKeys({ db, clinic: await db.Clinica.findByPk(ids.peerClinic),
          installationIds: [EXTRA.racePeer], enabled: true });
        assert.equal(mapping.keys.get(EXTRA.racePeer), `installation:${EXTRA.raceRoot}`);
        const allRooms = await get(url('/api/instalaciones', { clinica_id: `${ids.clinic},${ids.peerClinic}` }));
        assert.deepEqual(allRooms.find(row => row.id === EXTRA.racePeer).agenda_physical_alias_ids.map(Number).sort((a,b)=>a-b), [EXTRA.raceRoot, EXTRA.racePeer]);
        report.checks.push('Withdrawing a free canonical clinic disables its clinical member but retains alias IDs and resource key; the configuration list still groups disabled and active members into one physical room. No alias rekeying or deletion.');

        // A past frozen ledger is still documentary evidence. No topology
        // writer may rekey it just because all its dates are historical.
        const historicalRoot = 97501, historicalCandidate = 97502;
        await createRoom(historicalRoot, ids.clinic, [ids.doctorOne]);
        await createRoom(historicalCandidate, ids.peerClinic, [EXTRA.peerDoctor]);
        const old = await db.CitaPaciente.create({ clinica_id: ids.peerClinic, paciente_id: ids.foreignPatient,
          doctor_id: EXTRA.peerDoctor, instalacion_id: historicalCandidate, tipo_cita: 'continuacion', estado: 'pendiente',
          inicio: '2025-01-07T09:00:00Z', fin: '2025-01-07T09:30:00Z', source_system: 'owned_mysql_qa',
          nota: 'OWNED fictitious past ledger, not an import' });
        await db.AppointmentBookingOccupancy.create({ appointment_id: old.id_cita, phase_key: 'care', resource_kind: 'installation',
          resource_key: `installation:${historicalCandidate}`, installation_id: historicalCandidate,
          start_at: old.inicio, end_at: old.fin });
        const historyBefore = await evidence(old.id_cita), historyPlan = await sharing(historicalRoot);
        historyPlan.memberships.push({ clinic_id: ids.peerClinic, installation_id: historicalCandidate,
          enabled: true, professional_mode: 'selected', professional_ids: [EXTRA.peerDoctor] });
        await rejected('PUT', `/api/instalaciones/${historicalRoot}`, { physical_sharing: historyPlan },
          { status: 409, code: 'installation_sharing_review_required' });
        assert.deepEqual(await evidence(old.id_cita), historyBefore);
        const gateBefore = process.env.BOOKING_PROFILES_ENABLED;
        try {
          process.env.BOOKING_PROFILES_ENABLED = 'false';
          const gated = await sharing(historicalRoot);
          gated.memberships.push({ clinic_id: EXTRA.thirdClinic, installation_id: null,
            enabled: true, professional_mode: 'all', professional_ids: [] });
          await rejected('PUT', `/api/instalaciones/${historicalRoot}`, { physical_sharing: gated },
            { status: 409, code: 'installation_sharing_runtime_required' });
        } finally { process.env.BOOKING_PROFILES_ENABLED = gateBefore; }

        const reenabled = await sharing(EXTRA.racePeer);
        reenabled.memberships.find(row => row.installation_id === EXTRA.raceRoot).enabled = true;
        const reenable = await request('PUT', `/api/instalaciones/${EXTRA.racePeer}`, { physical_sharing: reenabled }, owner);
        assert.equal(reenable.status, 200, JSON.stringify(reenable.body));
        const twoStepTreatment = 95520;
        await db.Tratamiento.create({ id_tratamiento: twoStepTreatment, clinica_id: ids.peerClinic, grupo_clinica_id: ids.group,
          nombre: 'OWNED genuine secondary-room ledger', origen: 'clinica', disciplina: 'medicina', activo: true,
          precio_base: 0, eliminado_por_clinica: [], clinical_config: { catalog_status: 'active', booking_profile: { version: 4,
            phases: [
              { ...profile(EXTRA.peerRoom, EXTRA.peerDoctor).phases[0], key: 'first', duration_minutes: 15, start_offset_minutes: 0 },
              { ...profile(EXTRA.racePeer, EXTRA.peerAlternativeDoctor).phases[0], key: 'secondary', duration_minutes: 15, start_offset_minutes: 15 },
            ] } } });
        const secondary = await reserveNative(appointment({ clinic: ids.peerClinic, patient: ids.foreignPatient,
          treatment: twoStepTreatment, room: EXTRA.peerRoom, doctor: EXTRA.peerDoctor, start: '2030-01-21T09:00:00Z' }));
        assert.equal(secondary.status, 201, JSON.stringify(secondary.body));
        const secondaryBefore = await evidence(secondary.body.id_cita);
        assert.equal(secondaryBefore.appointment.instalacion_id, EXTRA.peerRoom);
        assert(secondaryBefore.occupancy.some(row => row.installation_id === EXTRA.racePeer && row.resource_key === `installation:${EXTRA.raceRoot}`));
        try {
          process.env.BOOKING_PROFILES_ENABLED = 'false';
          const gatedWithdrawal = await sharing(EXTRA.raceRoot);
          gatedWithdrawal.memberships.find(row => row.installation_id === EXTRA.racePeer).enabled = false;
          await rejected('PUT', `/api/instalaciones/${EXTRA.raceRoot}`, { physical_sharing: gatedWithdrawal },
            { status: 409, code: 'installation_sharing_review_required' });
        } finally { process.env.BOOKING_PROFILES_ENABLED = gateBefore; }
        assert.deepEqual(await evidence(secondary.body.id_cita), secondaryBefore);
        report.checks.push('Native SQL refuses an explicit link when a past frozen ledger exists, retaining row IDs and resource keys; process-local closed gate prevents new topology, and cannot erase a genuine secondary-room future v4 reservation through the legacy primary-room projection.');

        const counts = await sideEffects();
        report.sharedRoomIntegration = { native_authenticated_http: true, native_sql: true, native_lock_wait_witnesses: 2,
          synthetic_clinic_ids: [ids.clinic, ids.peerClinic, EXTRA.thirdClinic, EXTRA.unrelatedClinic],
          synthetic_group_ids: [ids.group, EXTRA.unrelatedGroup], synthetic_patients: 2,
          created_appointments: await db.CitaPaciente.count(), immutable_occupancies: await db.AppointmentBookingOccupancy.count(),
          external_provider_fetch_attempts: f.externalFetchAttempts, side_effect_counts: counts, native_http_requests: f.requests,
          cleanup: 'Only OWNED HTTP/SQL handles and OWNED mysqld PID are closed; pending transactions roll back in finally. No real configured DB, row DELETE or application runtime flag is touched.',
          boundary: 'Actual JWT/MFA/session/clinic ACL, routers, controllers, services, model factories, InnoDB SQL, solver and native waiting locks; email enqueue is an OWNED invalid-address SQL outbox; not a browser/visual proof.' };
      } finally { await f.close(); }
    }, { performanceSchema: true });
  });
