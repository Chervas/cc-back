'use strict';

// Explicit opt-in, real private socket-only mysqld. No shared database, app
// bootstrap, credentials or provider. HTTP uses native handlers with a scoped
// synthetic ACL; authentication itself is covered by the owned auth suite.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), http = require('node:http'), { createRequire } = require('node:module');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedBookingDurationFixture } = require('./helpers/owned-booking-duration-fixture');
const clone = value => JSON.parse(JSON.stringify(value));
function scopedModule(filename, overrides) {
  const local = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, console, Date, Map, Set, Promise, structuredClone,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name) }, { filename });
  return module.exports;
}
test('owned SQL + HTTP: clinical enrollment without economic/outbound writes, immutable snapshot, real booking and replay',
  { skip: process.env.PATIENT_PROGRAM_ENROLLMENT_MYSQL_TEST !== '1', timeout: 150000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql, models: db, report, registerOwnedLoopbackServer }) => {
      const physical = await createOwnedBookingDurationFixture({ sql, models: db, nativeCatalogModel: true, includePatientScope: true });
      // Only the message parent's identity is needed: no sender/channel or
      // conversation service participates in clinical enrollment/booking.
      db.Conversation = sql.define('Conversation', { id: { type: S.INTEGER, primaryKey: true } }, { tableName: 'Conversations', timestamps: false });
      for (const file of ['treatmentprogram', 'treatmentprogramrevision', 'economicbudget', 'economicbudgetversion', 'economicbudgetevent', 'economicpayment',
        'patientvoucher', 'patientvouchermovement', 'patientprogramsession', 'patientprogrambookingrequest', 'patientoperationalevent', 'patientfiscaldocument',
        'patientconsentdocument', 'consentsignaturepackage', 'consentdeliveryevent', 'jobrequest', 'flowexecutionv2', 'automationflowtemplatev2', 'message']) {
        const model = require('../../../models/' + file)(sql, S.DataTypes); db[model.name] = model;
      }
      for (const model of Object.values(sql.models)) (model.options.indexes || []).forEach((index, i) => {
        if (!index.name || index.name.length > 64) index.name = `qa_enrollment_${model.name.slice(0, 25)}_${i}`;
      });
      await sql.sync();
      const legacy = await db.PatientVoucher.create({ public_id: 'legacy-owned-budget-voucher', clinic_id: 100, patient_id: 2,
        name: 'Histórico ficticio', total_units: 1, available_units: 1, sold_amount: 10, status: 'pending' });
      const beforeMigration = clone(await legacy.reload()); delete beforeMigration.program_snapshot;
      // Exercise the exact bounded online migration adapter against the owned
      // SQL server, including idempotent second invocation and legacy NULLs.
      await sql.query('ALTER TABLE PatientVouchers DROP COLUMN program_snapshot');
      const adapter = require('../program-enrollment-schema-release').boundedInterface({ query: async (query, replacements) =>
        sql.query(query, { replacements: replacements || [] }) }, S);
      const migration = require('../../../migrations/20261020170000-add-patient-program-enrollment-snapshot');
      await migration.up(adapter, S); await migration.up(adapter, S);
      assert.equal((await legacy.reload()).program_snapshot, null);
      const afterMigration = clone(await legacy.reload()); delete afterMigration.program_snapshot;
      assert.deepEqual(afterMigration, beforeMigration);
      const [[column]] = await sql.query("SELECT COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='PatientVouchers' AND COLUMN_NAME='program_snapshot'");
      assert.deepEqual(column, { COLUMN_TYPE: 'json', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null });
      report.checks.push('Exact bounded ALGORITHM=INSTANT JSON NULL migration runs twice on real owned MySQL without backfill or legacy row changes');

      // Runtime capabilities are owned process-only fixture switches. No app
      // environment or external operator configuration is imported or changed.
      Object.assign(process.env, { TREATMENT_PROGRAM_ECONOMICS_ENABLED: 'true', TREATMENT_PROGRAM_BOOKING_ENABLED: 'true',
        BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true', BOOKING_PHASE_OFFSETS_ENABLED: 'true' });
      const price = { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 0, exemption_reason: 'QA ficticio, no emitir' };
      const treatments = [];
      for (const [id, installation, doctor] of [[30, 101, 1], [31, 102, 2]]) {
        await db.Tratamiento.create({ id_tratamiento: id, clinica_id: 100, origen: 'clinica', activo: true, nombre: 'Ficticio ' + id,
          disciplina: 'estetica', duracion_min: 30, precio_base: 50, clinical_config: { catalog_status: 'active', price_profile: price,
            booking_profile: { version: 1, phases: [{ key: 'care', duration_minutes: 30, installation_ids: [installation],
              professionals: { mode: 'any', ids: [doctor], preferred_id: doctor } }] } } });
        treatments.push(id);
      }
      const programs = require('../../services/treatmentPrograms.service').createTreatmentProgramsService({ db });
      const created = await programs.create({ clinicId: 100, actorId: 1, payload: { name: 'Programa clínico ficticio', kind: 'program', status: 'active',
        total_price: 150, price_profile: price, appointments: [0, 15, 30].map((offset_days, index) => ({ key: 's' + index, label: 'Visita ' + index, offset_days, treatment_ids: treatments })) } });
      assert.equal(created.item.commercial_ready, true);
      const enrollment = require('../../services/patientProgramEnrollment.service').createPatientProgramEnrollmentService({ db, programs,
        enabled: () => true, capabilities: () => physical.capabilities, now: () => new Date('2030-01-01Z') });
      const booking = require('../../services/patientProgramBooking.service').createPatientProgramBookingService({ db, enabled: () => true,
        capabilities: () => physical.capabilities, now: () => new Date('2030-01-01Z') });
      const forbidden = ['EconomicBudget', 'EconomicBudgetVersion', 'EconomicBudgetEvent', 'EconomicPayment', 'PatientFiscalDocument', 'PatientVoucherMovement',
        'PatientConsentDocument', 'ConsentSignaturePackage', 'ConsentDeliveryEvent', 'JobRequest', 'FlowExecutionV2', 'Message'];
      const counts = async () => Object.fromEntries(await Promise.all(forbidden.map(async name => [name, await db[name].count()])));
      const zero = await counts(); assert(Object.values(zero).every(value => value === 0));
      const acl = [], deniedFeatures = new Set(); let packagePreparationAttempts = 0;
      const controller = scopedModule(require.resolve('../../controllers/patientEconomics.controller'), {
        '../../models': db, '../services/patientEconomics.service': { domainError: require('../../lib/treatmentPrograms.contract').domainError },
        '../services/economicDocumentPdf.service': {}, '../services/patientVoucherAppointments.service': {},
        '../services/patientProgramEnrollment.service': enrollment, '../services/patientProgramBooking.service': booking,
        '../lib/access-policy': { getAccessibleClinicIdsForFeature: async value => { acl.push(value); return deniedFeatures.has(value.featureKey) ? [] : value.clinicIds; } },
        '../services/programBookingRealtime.service': { publishProgramBookings: async () => {} },
        '../services/consentimientos.service': { ensurePackageForAppointment: async () => { packagePreparationAttempts++; return null; } },
      });
      const app = require('express')(); app.use(require('express').json());
      const base = '/api/economics';
      const router = scopedModule(require.resolve('../../routes/patientEconomics.routes'), {
        '../controllers/patientEconomics.controller': controller,
        './auth.middleware': (req, res, next) => { req.userData = { userId: Number(req.headers['x-owned-actor'] || 1) }; next(); },
      });
      app.use(base, router);
      app.use((error, req, res, next) => res.status(error.statusCode || error.status || 500).json({ code: error.code, message: error.message, details: error.details }));
      const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); registerOwnedLoopbackServer(server);
      const send = (method, path, body, actor = 1) => new Promise((resolve, reject) => {
        const bytes = body == null ? null : Buffer.from(JSON.stringify(body));
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: base + path, method,
          headers: { 'content-type': 'application/json', 'x-owned-actor': actor, ...(bytes ? { 'content-length': bytes.length } : {}) } }, res => {
          const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString()); resolve({ status: res.statusCode, body: body.error || body });
          });
        }); req.on('error', reject); req.end(bytes);
      });
      try {
        const body = { clinic_id: 100, program_id: created.item.id, program_version: created.item.version, request_key: 'owned-clinical-enrollment-one' };
        for (const feature of ['patients.edit', 'patients.sensitive.view', 'appointments.manage']) {
          deniedFeatures.add(feature); const result = await send('POST', '/patients/1/program-enrollments', body);
          assert.equal(result.status, 403); deniedFeatures.clear(); assert.equal(await db.PatientVoucher.count(), 1);
        }
        assert.equal((await send('POST', '/patients/1/program-enrollments', { ...body, clinic_id: 200 })).status, 404);
        const [one, two] = await Promise.all([send('POST', '/patients/1/program-enrollments', body), send('POST', '/patients/1/program-enrollments', body)]);
        assert.deepEqual([one.status, two.status].sort(), [200, 201]); assert.equal(one.body.voucher_id, two.body.voucher_id);
        assert.equal(one.body.commercial_status, 'not_contracted'); assert.equal(one.body.sold_amount, null); assert.equal(one.body.catalog_reference_amount, 150);
        assert.equal(acl.some(value => /billing|econom/.test(value.featureKey)), false);
        assert.deepEqual(await counts(), zero); assert.equal(await db.PatientOperationalEvent.count(), 1);
        assert.equal((await send('POST', '/patients/2/program-enrollments', body)).body.code, 'program_enrollment_request_conflict');
        assert.equal((await send('POST', '/patients/1/program-enrollments', { ...body, program_snapshot: {} })).status, 400);
        const auditFailure = require('../../services/patientProgramEnrollment.service').createPatientProgramEnrollmentService({
          db: { ...db, PatientOperationalEvent: { create: async () => { throw Error('OWNED_AUDIT_FAILURE'); } } }, programs,
          enabled: () => true, capabilities: () => physical.capabilities });
        await assert.rejects(auditFailure.assign({ patientIdentifier: 2, clinicId: 100, actorId: 1,
          payload: { ...body, request_key: 'owned-audit-rollback-request' } }), /OWNED_AUDIT_FAILURE/);
        assert.equal(await db.PatientVoucher.count(), 2); assert.equal(await db.PatientOperationalEvent.count(), 1);
        const assigned = await db.PatientVoucher.findOne({ where: { public_id: one.body.voucher_id } });
        assert.equal(assigned.budget_id, null); assert.equal(Number(assigned.available_units), 3);
        const frozenHash = assigned.program_snapshot.sha256;
        await programs.update({ id: created.item.id, clinicId: 100, actorId: 1,
          payload: { expected_version: 1, name: 'Nueva versión, no cambia asignación anterior', total_price: 180 } });
        const previousVersionReplay = await send('POST', '/patients/1/program-enrollments', body);
        assert.equal(previousVersionReplay.status, 200); assert.equal(previousVersionReplay.body.program_version, 1);
        assert.equal(previousVersionReplay.body.catalog_reference_amount, 150); assert.equal((await assigned.reload()).program_snapshot.sha256, frozenHash);
        const duplicate = await send('POST', '/patients/1/program-enrollments', { ...body, request_key: 'owned-clinical-enrollment-another' });
        assert.equal(duplicate.status, 409); assert.equal(duplicate.body.details.voucher_id, assigned.public_id);
        assert.equal((await send('POST', '/patients/1/program-enrollments', body, 2)).body.code, 'program_enrollment_request_conflict');
        const url = '/vouchers/' + assigned.public_id;
        const plan = await send('GET', url + '/program-plan?clinic_id=100'); assert.equal(plan.status, 200, JSON.stringify(plan.body));
        assert.equal(plan.body.can_schedule, true); assert.equal(plan.body.origin, 'program_enrollment');
        const proposed = await send('POST', url + '/program-proposals', { from_date: '2030-02-04', days: 45 });
        assert.equal(proposed.status, 200, JSON.stringify(proposed.body)); assert.equal(proposed.body.proposals.length, 3);
        const sessions = proposed.body.proposals.map(row => ({ key: row.key, start_at: row.solution.start_at,
          selections: Object.fromEntries(row.solution.phases.map(phase => [phase.key, { installation_id: phase.installation_id,
            doctor_id: phase.doctor_ids[0] }])) }));
        const reservation = { request_key: 'owned-direct-booking-request', snapshot_sha256: plan.body.snapshot_sha256, sessions };
        const booked = await send('POST', url + '/program-appointments', reservation); assert.equal(booked.status, 201, JSON.stringify(booked.body));
        assert.equal(booked.body.sessions.length, 3); assert.equal(packagePreparationAttempts, 3);
        for (const session of booked.body.sessions) {
          const appointment = await db.CitaPaciente.findByPk(session.appointment_id);
          assert.equal(appointment.import_metadata.automation_policy, 'hold');
          for (const field of ['appointment_details', 'day_before', 'same_day']) assert.equal(appointment.import_metadata.notification_suppression[field], true);
          assert((await physical.occupancy(appointment.id_cita)).length >= 4);
        }
        const repeat = await send('POST', url + '/program-appointments', reservation); assert.equal(repeat.status, 201); assert.equal(repeat.body.replayed, true);
        assert.equal(await db.CitaPaciente.count({ where: { voucher_id: assigned.id } }), 3); assert.equal(packagePreparationAttempts, 3);
        assert.equal((await send('GET', url + '/program-plan?clinic_id=100')).body.pending_count, 0);
        assert.deepEqual(await counts(), zero); assert.equal(Number((await assigned.reload()).available_units), 3);
        assert.equal(await db.PatientVoucher.count(), 2);
        // Source hook integration, not just a hand-built domain fixture: enable
        // only this private process, with NO published automation or sender.
        // The complete reschedule must persist one disabled notice alongside
        // its receipt, never create jobs/messages or claim anything was sent.
        process.env.PATIENT_PROGRAM_BOOKING_NOTICE_ENABLED = 'true';
        const current = await send('GET', url + '/program-plan?clinic_id=100');
        const shift = { mode: 'reschedule', reschedule_scope: 'following', replan_from_key: 's0', expected_plan_revision: current.body.plan_revision };
        const shiftPreview = await send('POST', url + '/program-proposals', { ...shift, reschedule_start_local: '2030-02-11T09:00' });
        assert.equal(shiftPreview.status, 200, JSON.stringify(shiftPreview.body)); assert(shiftPreview.body.proposals.every(row => row.solution));
        const shiftedRequest = { ...shift, request_key: 'owned-direct-shift-notice', snapshot_sha256: current.body.snapshot_sha256,
          sessions: shiftPreview.body.proposals.map(row => ({ key: row.key, start_at: row.solution.start_at, selections: row.selections, priority_acknowledged: row.priority_acknowledged })) };
        const shiftResult = await send('POST', url + '/program-appointments', shiftedRequest);
        assert.equal(shiftResult.status, 201, JSON.stringify(shiftResult.body)); assert.equal(shiftResult.body.communication.sent, false);
        assert.equal(shiftResult.body.communication.status, 'not_available');
        assert.equal(await db.PatientOperationalEvent.count({ where: { event_type: 'patient.program_appointments_booked' } }), 1);
        const shiftReplay = await send('POST', url + '/program-appointments', shiftedRequest);
        assert.equal(shiftReplay.body.replayed, true); assert.deepEqual(shiftReplay.body.communication, shiftResult.body.communication);
        assert.equal(await db.PatientOperationalEvent.count({ where: { event_type: 'patient.program_appointments_booked' } }), 1);
        assert.deepEqual(await counts(), zero); assert.equal(await db.CitaPaciente.count({ where: { voucher_id: assigned.id } }), 3);
        delete process.env.PATIENT_PROGRAM_BOOKING_NOTICE_ENABLED;
        await assert.rejects(assigned.update({ program_snapshot: null }), error => error.code === 'PROGRAM_ENROLLMENT_SNAPSHOT_IMMUTABLE');
        await assigned.reload();
        report.checks.push('Native HTTP guards require patient edit/sensitive + agenda manage, never billing; real scoped catalog resolution freezes snapshot; concurrent enrollment creates once; replay, duplicate-active and actor checks preserve zero financial/outbound rows');
        report.checks.push('Real proposals + canonical atomic booking create three appointments/phase occupancies from clinical enrollment with no budget; HOLD/suppressions remain; receipt retry duplicates nothing; no movements, jobs, flows, messages, consents, payments or economic documents');
        report.checks.push('Actual booking hook with owned-only notice gate enabled records one disabled aggregate event atomically with reschedule/receipt; replay returns its persisted communication without another event, and inactive/unconfigured sending creates zero jobs/flows/messages');
        // A program begun outside Clinicaclick manages only its suffix. The
        // prefix has no historical appointment, attendance or consumption.
        const externalBody = { ...body, program_version: 2, request_key: 'owned-external-program-entry', start_from_position: 2 };
        const invalidEntry = await send('POST', '/patients/2/program-enrollments', { ...externalBody, start_from_position: 4 });
        assert.equal(invalidEntry.status, 400); assert.equal(await db.PatientVoucher.count(), 2);
        const [entryOne, entryTwo] = await Promise.all([send('POST', '/patients/2/program-enrollments', externalBody), send('POST', '/patients/2/program-enrollments', externalBody)]);
        assert.deepEqual([entryOne.status, entryTwo.status].sort(), [200, 201]);
        assert.equal(entryOne.body.voucher_id, entryTwo.body.voucher_id);
        assert.equal(entryOne.body.start_from_position, 2); assert.equal(entryOne.body.unrecorded_units, 1);
        assert.equal(entryOne.body.managed_units, 2); assert.equal(entryOne.body.consumed_units, 0);
        assert.equal(entryOne.body.sold_amount, null); assert.equal(entryOne.body.catalog_reference_amount, 180);
        const externalVoucher = await db.PatientVoucher.findOne({ where: { public_id: entryOne.body.voucher_id } });
        assert.equal(Number(externalVoucher.total_units), 3); assert.equal(Number(externalVoucher.available_units), 2);
        assert.equal(externalVoucher.program_snapshot.enrollment.prior_sessions, 'unrecorded');
        const externalUrl = '/vouchers/' + externalVoucher.public_id;
        const externalPlan = await send('GET', externalUrl + '/program-plan?clinic_id=100');
        assert.equal(externalPlan.status, 200, JSON.stringify(externalPlan.body));
        assert.deepEqual(externalPlan.body.sessions.map(row => [row.key, row.position, row.scheduling_status]), [['s0', 0, 'unrecorded'], ['s1', 1, 'pending'], ['s2', 2, 'pending']]);
        assert.equal(externalPlan.body.pending_count, 2); assert.equal(externalPlan.body.consumed_units, 0);
        // The HTTP guard derives the authoritative clinic from the voucher,
        // never a client query; the service still rejects a wrong scoped ID.
        await assert.rejects(booking.read({ publicId: externalVoucher.public_id, clinicId: 200 }), error => error.code === 'program_purchase_not_found');
        deniedFeatures.add('patients.view');
        assert.equal((await send('GET', externalUrl + '/program-plan?clinic_id=200')).status, 403); deniedFeatures.clear();
        assert.equal((await send('POST', '/patients/2/program-enrollments', { ...externalBody, start_from_position: 3 })).body.code, 'program_enrollment_request_conflict');
        assert.equal((await send('POST', '/patients/2/program-enrollments', { ...externalBody, request_key: 'owned-external-another-uuid' })).body.code, 'program_enrollment_already_active');
        const beforePreview = await physical.counts();
        const draft = await send('POST', externalUrl + '/program-proposals', { from_date: '2030-03-01', days: 45, draft_strategy: { action: 'initial' } });
        assert.equal(draft.status, 200, JSON.stringify(draft.body));
        assert.deepEqual(draft.body.proposals.map(row => row.key), ['s1', 's2']);
        assert.equal(draft.body.proposals[0].solution.start_local.slice(0, 10), '2030-03-01');
        const preferredDraft=await send('POST',externalUrl+'/program-proposals',{from_date:'2030-03-01',days:45,
          draft_strategy:{action:'initial',start_local:'2030-03-01T09:00',preferences:{exclude_weekdays:[5],prefer_after_minutes:960,keep_professional:true}}});
        assert.equal(preferredDraft.status,200,JSON.stringify(preferredDraft.body));
        assert.equal(preferredDraft.body.proposals[0].solution.start_local,'2030-03-04T16:00');
        const draftRows = draft.body.proposals.map(row => ({ key: row.key, placed: true, start_at: row.solution.start_at,
          selections: Object.fromEntries(row.solution.phases.map(phase => [phase.key, { installation_id: phase.installation_id, doctor_id: phase.doctor_ids[0] }])) }));
        const cascade = await send('POST', externalUrl + '/program-proposals', { from_date: '2030-03-01', days: 45,
          draft_strategy: { action: 'cascade', pivot_key: 's1', start_local: '2030-03-25T10:00', sessions: draftRows } });
        assert.equal(cascade.status, 200, JSON.stringify(cascade.body)); assert(cascade.body.proposals.every(row => row.solution));
        assert.equal(cascade.body.proposals[0].solution.start_local, '2030-03-25T10:00');
        assert.equal(cascade.body.proposals[1].solution.start_local.slice(11), '10:00');
        const occupiedDraft = await send('POST', externalUrl + '/program-proposals', { from_date: '2030-03-01', days: 45,
          draft_strategy: { action: 'cascade', pivot_key: 's1', start_local: '2030-02-11T09:00', sessions: draftRows } });
        assert.equal(occupiedDraft.status, 200, JSON.stringify(occupiedDraft.body));
        assert.equal(occupiedDraft.body.proposals[0].solution, null);
        assert.equal(occupiedDraft.body.proposals[0].placed, false);
        assert.equal(occupiedDraft.body.proposals[1].placed, true);
        assert(occupiedDraft.body.proposals[1].solution);
        assert.deepEqual(occupiedDraft.body.draft_strategy.placed_keys,['s2']);
        assert.equal(occupiedDraft.body.proposals[0].requires_schedule_confirmation, undefined);
        const badResource = clone(draftRows); badResource[0].selections[Object.keys(badResource[0].selections)[0]].doctor_id = 999;
        assert.equal((await send('POST', externalUrl + '/program-proposals', { from_date: '2030-03-01', days: 45,
          draft_strategy: { action: 'reset', sessions: badResource } })).body.code, 'program_selection_invalid');
        assert.equal((await send('POST', externalUrl + '/program-proposals', { from_date: '2030-03-01', days: 45,
          draft_strategy: { action: 'cascade', pivot_key: 's1', start_local: '2030-03-31T02:30', sessions: draftRows } })).body.code, 'voucher_schedule_dst_conflict');
        assert.deepEqual(await physical.counts(), beforePreview); assert.deepEqual(await counts(), zero);
        assert.equal(await db.PatientProgramSession.count({ where: { voucher_id: externalVoucher.id } }), 0);
        assert.equal(await db.PatientProgramBookingRequest.count({ where: { voucher_id: externalVoucher.id } }), 0);
        // Even a corrupted prefix record cannot turn the unrecorded interval
        // into historical care or reduce its managed balance. All corruption
        // is rolled back inside this owned test transaction.
        const corrupt = await sql.transaction();
        try {
          await db.PatientProgramSession.create({ voucher_id: externalVoucher.id, session_key: 's0', position: 0,
            snapshot_sha256: externalVoucher.program_snapshot.sha256, snapshot: externalVoucher.program_snapshot.appointments[0], appointment_id: 999999 }, { transaction: corrupt });
          await assert.rejects(booking.read({ publicId: externalVoucher.public_id, clinicId: 100, transaction: corrupt }), error => error.code === 'program_session_inconsistent');
          await assert.rejects(require('../../services/patientProgramBooking.service').consumeProgramSession({ db,
            appointment: { id_cita: 999999, clinica_id: 100, paciente_id: 2 }, voucher: externalVoucher, transaction: corrupt, actorId: 1 }),
          error => error.code === 'program_session_unrecorded');
        } finally { await corrupt.rollback(); }
        const externalReservation = { request_key: 'owned-external-suffix-booking', snapshot_sha256: externalPlan.body.snapshot_sha256,
          booking_preferences:{exclude_weekdays:[5],prefer_after_minutes:960,keep_professional:true},
          sessions: cascade.body.proposals.map(row => ({ key: row.key, start_at: row.solution.start_at, selections: row.selections })) };
        const excludedFriday=await send('POST',externalUrl+'/program-appointments',{...externalReservation,request_key:'owned-friday-local-rejected',
          sessions:[{...externalReservation.sessions[0],start_at:'2030-03-14T23:30:00Z'}]});
        assert.equal(excludedFriday.body.code,'program_booking_preference_conflict');assert.deepEqual(await physical.counts(),beforePreview);
        const prefixAttempt = await send('POST', externalUrl + '/program-appointments', { ...externalReservation,
          request_key: 'owned-external-prefix-rejected', sessions: [{ ...externalReservation.sessions[0], key: 's0' }] });
        assert.equal(prefixAttempt.body.code, 'program_session_not_pending'); assert.deepEqual(await physical.counts(), beforePreview);
        const externalBooked = await send('POST', externalUrl + '/program-appointments', externalReservation);
        assert.equal(externalBooked.status, 201, JSON.stringify(externalBooked.body)); assert.equal(externalBooked.body.sessions.length, 2);
        const externalReplay = await send('POST', externalUrl + '/program-appointments', externalReservation);
        assert.equal(externalReplay.body.replayed, true);
        assert.deepEqual(externalReplay.body.booking_preferences,externalReservation.booking_preferences);
        const changedPreference={...externalReservation,booking_preferences:{exclude_weekdays:[6]}};
        assert.equal((await send('POST',externalUrl+'/program-appointments',changedPreference)).body.code,'program_booking_request_conflict');
        assert.deepEqual((await db.PatientProgramBookingRequest.findOne({where:{voucher_id:externalVoucher.id}})).result.booking_preferences,externalReservation.booking_preferences);
        const afterExternal = await send('GET', externalUrl + '/program-plan?clinic_id=100');
        assert.equal(afterExternal.body.pending_count, 0); assert.equal(afterExternal.body.unrecorded_units, 1);
        assert.equal(afterExternal.body.consumed_units, 0); assert.equal(afterExternal.body.managed_units, 2);
        assert.equal(Number((await externalVoucher.reload()).available_units), 2);
        assert.equal(await db.PatientProgramSession.count({ where: { voucher_id: externalVoucher.id } }), 2);
        assert.equal(await db.PatientProgramSession.count({ where: { voucher_id: externalVoucher.id, session_key: 's0' } }), 0);
        assert.deepEqual(await counts(), zero);
        for (const row of externalBooked.body.sessions) {
          const appointment = await db.CitaPaciente.findByPk(row.appointment_id);
          assert.equal(appointment.import_metadata.automation_policy, 'hold');
          for (const field of ['appointment_details', 'day_before', 'same_day']) assert.equal(appointment.import_metadata.notification_suppression[field], true);
        }
        report.checks.push('External entry N=2 seals full three-session composition with one unrecorded prefix, two managed units and zero actual consumption; concurrent/replay/duplicate/scope/forged-prefix checks fail closed; original keys and positions remain intact');
        report.checks.push('Real HTTP draft initial anchors session N directly at chosen day; civil cascade across DST retains phase resources, rejects DST gaps/foreign staff, writes no provisional appointments/occupancies/receipts; final native booking reserves only two managed sessions with HOLD and no economic/outbound/unit movements');
        // The budget-backed path remains strict, never reinterpreted as a
        // clinical enrollment even if somebody injects its JSON directly.
        const budget = await db.EconomicBudget.create({ public_id: 'owned-budget-still-pending', clinic_id: 100, patient_id: 2, number: 'QA', status: 'presented' });
        await legacy.update({ budget_id: budget.id, budget_line_key: 'line', source_system: 'treatment_program', status: 'active', total_units: 3, available_units: 3 });
        await db.EconomicBudgetVersion.create({ budget_id: budget.id, version_number: 1, lines: [{ key: 'line', program_snapshot: assigned.program_snapshot }],
          totals: {}, payment_proposal: {}, design_config: {}, clinic_snapshot: {}, patient_snapshot: {} });
        const blocked = await booking.read({ publicId: legacy.public_id, clinicId: 100, actorId: 1 }); assert.equal(blocked.can_schedule, false);
        await sql.query('UPDATE PatientVouchers SET program_snapshot=? WHERE id=?', { replacements: [JSON.stringify(assigned.program_snapshot), legacy.id] });
        await assert.rejects(booking.read({ publicId: legacy.public_id, clinicId: 100, actorId: 1 }), error => error.code === 'program_enrollment_origin_conflict');
        report.checks.push('Existing non-accepted budget remains not schedulable; forged mixed clinical/budget snapshot rejects rather than bypassing acceptance');
      } finally { await new Promise(resolve => server.close(resolve)); }
    });
  });
