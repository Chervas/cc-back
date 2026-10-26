'use strict';
// Native planner/solver/occupancy/transactions on an owned socket-only MySQL.
// ACL and post-commit communication hooks are explicit synthetic boundaries.
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedBookingDurationFixture } = require('./helpers/owned-booking-duration-fixture');
function load(file, overrides) {
  const local = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, console, Date, Map, Set, Promise, Object, Buffer,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name) }, { filename: file });
  return module.exports;
}
withIsolatedCampaignMysql(async ({ sql, models: db, report, registerOwnedLoopbackServer }) => {
  const base = await createOwnedBookingDurationFixture({ sql, models: db, includePatientScope: true }), D = db.Sequelize.DataTypes;
  for (const file of ['patientvoucher', 'patientvouchermovement', 'patientoperationalevent', 'economicbudget', 'economicbudgetversion',
    'economicbudgetevent', 'economicpayment', 'patientwalletentry', 'economicfundingpart', 'economicconceptadjustment', 'economicfiscalcoverage', 'patientfiscaldocument']) {
    const model = require('../../../models/' + file)(sql, D); db[model.name] = model;
  }
  db.PatientOperationalEvent.options.indexes.forEach((row, i) => { row.name = ['idx_patient_operational_events_patient_type_at', 'idx_patient_operational_events_clinic_type_at', 'idx_patient_operational_events_actor_at'][i]; });
  await sql.sync();
  const profile = require('../../services/treatmentBookingProfile.service'), availability = require('../../services/appointmentBookingAvailability.service');
  const command = require('../../services/appointmentBookingCommand.service');
  const state = { durable: true, hooks: [] };
  const native = load(require.resolve('../../services/patientVoucherAppointments.service'), {
    '../../models': db,
    './appointmentAutomationV2Runtime.service': { enqueueExecutionForCita: async row => state.hooks.push(['created', row.id_cita]), syncScheduledTriggersForCita: async row => state.hooks.push(['sync', row.id_cita]) },
    './treatmentBookingProfile.service': { ...profile, bookingCapabilities: () => base.capabilities,
      requireOperationalProfile: (treatment, options) => profile.requireOperationalProfile(treatment, { ...options, capabilities: base.capabilities }) },
    './appointmentBookingAvailability.service': { ...availability, loadBookingContext: options => availability.loadBookingContext({ ...options, equipmentEnabled: true }) },
    './appointmentBookingCommand.service': { mutateAppointmentBooking: options => command.mutateAppointmentBooking({ ...options, capabilities: base.capabilities }) },
    '../lib/voucher-booking-replay': { ...require('../../lib/voucher-booking-replay'), enabled: () => state.durable },
  });
  const canAccess = async input => Number(input.actorId) < 3 && Number(input.clinicId) === 100;
  const concepts = require('../../services/economicConcepts.service').createService({ db, canAccess });
  const service = require('../../services/budgetConceptAppointments.service').createService({ db, concepts, coordinator: native.seriesCoordinator,
    canAccess, replayEnabled: () => state.durable, automation: { enqueueExecutionForCita: async row => state.hooks.push(['created', row.id_cita]), syncScheduledTriggersForCita: async row => state.hooks.push(['sync', row.id_cita]) } });
  const budget = async (patch = {}) => {
    const row = await db.EconomicBudget.create({ public_id: crypto.randomUUID(), patient_id: 1, clinic_id: 100, status: 'accepted', current_version: 1, number: 'QA-' + crypto.randomUUID(), accepted_amount: 300, ...patch });
    const line = { key: 'three-sessions', name: 'Tratamiento de tres citas', treatment_id: patch.treatmentId || 1, quantity: 3, entitlement_units: 3, total: 300, accepted: true };
    await db.EconomicBudgetVersion.create({ budget_id: row.id, version_number: 1, lines: [line], totals: { total: 300 }, payment_proposal: {}, design_config: {}, clinic_snapshot: {}, patient_snapshot: {} });
    await db.EconomicBudgetEvent.create({ budget_id: row.id, version_number: 1, event_type: 'accepted', to_status: 'accepted', metadata: { accepted_line_keys: [line.key], accepted_amount: 300 }, created_at: new Date() });
    return row;
  };
  const input = (row, patch = {}) => JSON.parse(JSON.stringify({ publicId: row.public_id, lineKey: 'three-sessions', actorId: 1,
    payload: { expected_version: 1, start_at: '2030-01-07T09:00:00Z', count: 2, interval_days: 7, duration_minutes: 45, doctor_id: 1, installation_id: 101, ...patch } }));
  const seal = (request, proposal) => ({ ...request, payload: { ...request.payload, booking_request_key: proposal.booking_request_key, booking_request_sha256: proposal.booking_request_sha256 } });
  const counts = async () => ({ ...await base.counts(), events: await db.EconomicBudgetEvent.count(), receipts: await db.PatientOperationalEvent.count(), vouchers: await db.PatientVoucher.count(), movements: await db.PatientVoucherMovement.count(), payments: await db.EconomicPayment.count(), wallet: await db.PatientWalletEntry.count() });
  const b = await budget(), original = (await b.reload()).toJSON(), request = input(b);
  const resources = await service.resources({ publicId: b.public_id, lineKey: 'three-sessions', actorId: 1 });
  assert(resources.doctors.some(row => row.id === 1)); assert(resources.installations.some(row => row.id === 101));
  const proposal = await service.preview(request);
  assert.equal(proposal.voucher, undefined); assert.deepEqual(proposal.budget_concept, { budget_id: b.public_id, line_key: 'three-sessions', version: 1 });
  assert.equal(proposal.has_conflicts, false); assert.equal(proposal.appointments.length, 2);
  const sealed = seal(request, proposal), before = await counts();
  const both = await Promise.all([service.create(sealed), service.create(sealed)]);
  assert.equal(both.filter(row => row.replayed).length, 1); assert.deepEqual(JSON.parse(JSON.stringify(both[0].created)), JSON.parse(JSON.stringify(both[1].created)));
  assert.equal((await counts()).CitaPaciente, before.CitaPaciente + 2); assert.equal(state.hooks.length, 4);
  for (const created of both[0].created) {
    assert.equal((await base.read(created.id)).voucher_id, null); assert.equal((await base.occupancy(created.id)).length, 2);
    const event = await db.EconomicBudgetEvent.findOne({ where: { budget_id: b.id, event_type: 'appointment_linked', metadata: { appointment_id: created.id } } });
    assert.equal(event.metadata.line_key, 'three-sessions'); assert.equal(event.metadata.no_payment_or_clinical_effect, true);
  }
  assert.deepEqual((await b.reload()).toJSON(), original);
  assert.equal((await counts()).vouchers, 0); assert.equal((await counts()).movements, 0); assert.equal((await counts()).payments, 0); assert.equal((await counts()).wallet, 0);
  assert.equal((await concepts.bookingSource({ publicId: b.public_id, lineKey: 'three-sessions', actorId: 1 })).progress.pending, 1);
  await assert.rejects(service.preview(input(b, { start_at: '2030-01-08T09:00:00Z' })), { code: 'voucher_schedule_count_invalid' });
  report.checks.push('Accepted normal concept uses native resources/solver and two physical occupancy rows per appointment; concurrent exact requests create once, canonical links commit together, no voucher/payment/consumption is fabricated.');
  const savedCounts = await counts();
  await assert.rejects(service.create({ ...sealed, actorId: 2 }), { code: 'budget_booking_request_forbidden' });
  await assert.rejects(service.create({ ...sealed, actorId: 3 }), { code: 'access_policy_forbidden' });
  await assert.rejects(service.create({ ...sealed, lineKey: 'foreign-line' }), { code: 'budget_booking_receipt_invalid' });
  await assert.rejects(service.create({ ...sealed, payload: { ...sealed.payload, count: 1 } }), { code: 'voucher_booking_request_conflict' });
  assert.deepEqual(await counts(), savedCounts);
  await b.update({ status: 'superseded' });
  const replayed = await service.create(sealed); assert.equal(replayed.replayed, true); assert.deepEqual(JSON.parse(JSON.stringify(replayed.created)), JSON.parse(JSON.stringify(both[0].created)));
  assert.deepEqual(await counts(), savedCounts);
  report.checks.push('Actor/clinic/line and request tampering reject without effects; committed receipt survives later mutable budget state and never reopens reservations.');
  const fractional = await budget({ patient_id: 2 }), fractionalVersion = await db.EconomicBudgetVersion.findOne({ where: { budget_id: fractional.id } });
  await fractionalVersion.update({ lines: [{ ...fractionalVersion.lines[0], quantity: 1.5, entitlement_units: 1.5 }] });
  const fractionalBefore = await counts();
  await assert.rejects(service.preview(input(fractional, { count: 1 })), { code: 'budget_concept_sessions_review' });
  assert.deepEqual(await counts(), fractionalBefore);
  report.checks.push('Fractional product quantities are not silently treated as a contract for whole sessions and cannot create a reservation.');
  const rb = await budget({ patient_id: 3 }), rollbackRequest = input(rb, { start_at: '2030-01-09T09:00:00Z' });
  const rollbackSeal = seal(rollbackRequest, await service.preview(rollbackRequest)), rollbackBefore = await counts(); let writes = 0;
  db.CitaPaciente.addHook('afterCreate', 'owned-fail-second-concept', () => { if (++writes === 2) throw Error('OWNED_SECOND_SLOT_FAILURE'); });
  try { await assert.rejects(service.create(rollbackSeal), /OWNED_SECOND_SLOT_FAILURE/); }
  finally { db.CitaPaciente.removeHook('afterCreate', 'owned-fail-second-concept'); }
  assert.deepEqual(await counts(), rollbackBefore);
  assert.equal((await service.create(rollbackSeal)).created.length, 2);
  report.checks.push('A failure on the second slot rolls back the first appointment, occupancy, budget links and committed receipt; exact retry reserves the complete series once.');
  const agendaModule = load(require.resolve('../../services/appointmentAgendaOrigin.service'), {
    './treatmentBookingProfile.service': { ...profile,
      requireOperationalProfile: (treatment, options) => profile.requireOperationalProfile(treatment, { ...options, capabilities: base.capabilities }) },
    './appointmentBookingAvailability.service': { ...availability, loadBookingContext: options => availability.loadBookingContext({ ...options, equipmentEnabled: true }) },
  });
  const agenda = agendaModule.createService({ db, concepts, voucherBooking: native, conceptBooking: service, canAccess,
    replayEnabled: () => state.durable, now: () => new Date('2026-10-26T00:00Z') });
  const ab = await budget({ patient_id: 2 }), scope = { kind: 'budget_concept', publicId: ab.public_id, lineKey: 'three-sessions', clinicId: 100, patientId: 2, actorId: 1 };
  const agendaBefore = await counts(), read = await agenda.read(scope);
  assert.equal(read.source.budget_id, ab.public_id); assert.equal(read.kind, 'series'); assert.equal(read.pending_count, 3);
  assert.equal(read.sessions[0].appointment_id, null); assert.equal(read.scheduling_mode, 'manual'); assert.deepEqual(await counts(), agendaBefore);
  await assert.rejects(agenda.read({ ...scope, clinicId: 200 }), { code: 'access_policy_forbidden' });
  await assert.rejects(agenda.read({ ...scope, patientId: 1 }), { code: 'agenda_origin_not_found' });
  const card = (key, start_at, duration_minutes = 45) => ({ key, start_at, duration_minutes,
    selections: { care: { doctor_id: 1, installation_id: 101 } }, priority_acknowledged: true });
  const agendaInput = { ...scope, payload: { request_key: crypto.randomUUID(), expected_version: 1, snapshot_sha256: read.snapshot_sha256,
    plan_revision: read.plan_revision, sessions: [card('pending_1', '2027-01-04T09:00:00Z'), card('pending_3', '2027-01-06T11:00:00Z', 30)] } };
  const pair = await Promise.all([agenda.book(agendaInput), agenda.book(agendaInput)]);
  assert.equal(pair.filter(row => row.data.replayed).length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(pair[0].data.sessions)), JSON.parse(JSON.stringify(pair[1].data.sessions)));
  assert.equal(pair[0].data.request_key, agendaInput.payload.request_key); assert.equal(pair[0].data.booking_request_key, agendaInput.payload.request_key);
  assert.equal(pair[0].data.sessions[0].start_at, '2027-01-04T09:00:00.000Z');
  assert.equal(pair[0].data.sessions[1].start_at, '2027-01-06T11:00:00.000Z');
  assert.equal(pair[0].data.sessions[1].end_at, '2027-01-06T11:30:00.000Z');
  assert.equal((await agenda.read(scope)).pending_count, 1);
  const afterAgenda = await counts(); assert.equal(afterAgenda.CitaPaciente, agendaBefore.CitaPaciente + 2);
  assert.equal(afterAgenda.vouchers, agendaBefore.vouchers); assert.equal(afterAgenda.movements, agendaBefore.movements);
  assert.equal(afterAgenda.payments, agendaBefore.payments); assert.equal(afterAgenda.wallet, agendaBefore.wallet);
  await assert.rejects(agenda.book({ ...agendaInput, payload: { ...agendaInput.payload, sessions: [card('pending_1', '2027-01-05T09:00:00Z')] } }), { code: 'budget_booking_request_conflict' });
  await assert.rejects(agenda.book({ ...agendaInput, actorId: 2 }), { code: 'budget_booking_request_forbidden' });
  await ab.update({ status: 'superseded' });
  assert.equal((await agenda.book(agendaInput)).data.replayed, true); assert.deepEqual(await counts(), afterAgenda);
  const proposalBudget = await budget({ patient_id: 1, treatmentId: 4 }), proposalScope = { ...scope, publicId: proposalBudget.public_id, patientId: 1 };
  const proposalRead = await agenda.read(proposalScope), beforeDraft = await counts();
  const draft = await agenda.propose({ ...proposalScope, payload: { from_date: '2027-04-05', days: 90,
    draft_strategy: { action: 'cascade', pivot_key: 'pending_1', start_local: '2027-04-05T10:00',
      sessions: proposalRead.sessions.map(row => ({ key: row.key, placed: false })) } } });
  assert.equal(draft.proposals[0].solution.start_at, '2027-04-05T08:00:00.000Z');
  assert.equal(draft.proposals[1].solution, null); assert.equal(draft.booking_replay_supported, true);
  assert.deepEqual(await counts(), beforeDraft);
  report.checks.push('Shared agenda origin read is side-effect-free and scoped; a partial selection with independent dates and variable minutes uses the same native series engine. Concurrent/lost-ACK exact replay returns the original real IDs after pending/status changes; actor/key/body tampering cannot create another appointment or a fictitious program/voucher.');
  state.durable = false;
  await assert.rejects(service.create(sealed), { code: 'budget_booking_replay_disabled' });
  const relative = await budget({ patient_id: 4, treatmentId: 2 });
  const relativeInput = input(relative, { start_at: '2030-02-04T09:00:00Z', count: 1, duration_minutes: undefined, doctor_id: undefined, installation_id: undefined, phase_durations: { one: 40, two: 20 } });
  const relativePlan = await service.preview(relativeInput);
  assert.equal(relativePlan.configuration.duration_minutes, 40); assert.equal(relativePlan.booking_replay_supported, false);
  assert.equal(relativePlan.booking_request_key, undefined); assert.equal(relativePlan.appointments[0].phases.length, 2);
  const relativeCreated = await service.create(relativeInput); assert.equal(relativeCreated.created.length, 1);
  assert.equal((await base.read(relativeCreated.created[0].id)).voucher_id, null); assert.equal((await base.occupancy(relativeCreated.created[0].id)).length, 4);
  const voucher = await db.PatientVoucher.create({ public_id: crypto.randomUUID(), patient_id: 4, clinic_id: 100, treatment_id: 5,
    name: 'Bono clásico ficticio', status: 'active', total_units: 3, available_units: 3, sold_amount: 300 });
  const voucherScope = { kind: 'voucher', publicId: voucher.public_id, clinicId: 100, patientId: 4, actorId: 1 };
  const voucherRead = await agenda.read(voucherScope), voucherBefore = await counts();
  assert.equal(voucherRead.booking_replay_supported, false); assert.equal(voucherRead.sessions[0].booking_profile.phases[0].key, 'visit');
  const legacyRow = (key, start_at, doctor_id, installation_id, duration_minutes) => ({ key, start_at, duration_minutes,
    selections: { visit: { doctor_id, installation_id } }, priority_acknowledged: false });
  const voucherInput = { ...voucherScope, payload: { request_key: crypto.randomUUID(), snapshot_sha256: voucherRead.snapshot_sha256,
    plan_revision: voucherRead.plan_revision, sessions: [legacyRow('pending_1', '2027-03-01T09:00:00Z', 1, 101, 40),
      legacyRow('pending_2', '2027-03-04T11:00:00Z', 2, 102, 25)] } };
  const legacyReceipt = await agenda.book(voucherInput);
  assert.equal(legacyReceipt.booking_replay_supported, false); assert.equal(legacyReceipt.data.booking_request_key, undefined);
  assert.equal(legacyReceipt.data.request_key, voucherInput.payload.request_key);
  assert.equal((await base.read(legacyReceipt.data.sessions[0].appointment_id)).doctor_id, 1);
  assert.equal((await base.read(legacyReceipt.data.sessions[1].appointment_id)).doctor_id, 2);
  assert.equal((await base.read(legacyReceipt.data.sessions[1].appointment_id)).instalacion_id, 102);
  assert.equal(legacyReceipt.data.sessions[1].end_at, '2027-03-04T11:25:00.000Z');
  assert.equal((await counts()).receipts, voucherBefore.receipts); assert.equal((await counts()).movements, voucherBefore.movements);
  const savedVoucher = await agenda.read(voucherScope); assert.equal(savedVoucher.pending_count, 1); assert.equal(savedVoucher.reserved_appointments.length, 2);
  await assert.rejects(agenda.book(voucherInput), { code: 'agenda_origin_plan_changed' });
  const linked = await db.CitaPaciente.findByPk(legacyReceipt.data.sessions[0].appointment_id);
  await linked.update({ inicio: '2027-03-01T10:00:00Z', fin: '2027-03-01T10:40:00Z' });
  const moved = await agenda.read(voucherScope); assert.notEqual(moved.plan_revision, savedVoucher.plan_revision);
  assert.equal(moved.snapshot_sha256, savedVoucher.snapshot_sha256);
  const beforeStale = await counts();
  await assert.rejects(agenda.book({ ...voucherScope, payload: { ...voucherInput.payload, request_key: crypto.randomUUID(),
    plan_revision: savedVoucher.plan_revision, sessions: [legacyRow('pending_1', '2027-03-08T09:00:00Z', 1, 101, 30)] } }), { code: 'agenda_origin_plan_changed' });
  assert.deepEqual(await counts(), beforeStale);
  report.checks.push('The same shared manual draft uses native availability and Madrid DST without writes. A classic legacy voucher books independent explicit dates, minutes, doctors and rooms with replay closed, returns real IDs, creates no recovery journal or consumption, and a date-only reschedule invalidates the source revision.');
  const controller = load(require.resolve('../../controllers/patientEconomics.controller'), {
    '../../models': db, '../services/patientEconomics.service': { domainError: native.domainError }, '../services/economicDocumentPdf.service': {},
    '../services/patientProgramBooking.service': {}, '../services/accountingFirms.service': { isPortalUser: async ({ actorId }) => actorId === 9 },
    '../services/patientVoucherAppointments.service': native,
    '../services/programBookingRealtime.service': { publishProgramBookings: async () => state.hooks.push(['realtime']) },
    '../services/consentimientos.service': { ensurePackageForAppointment: async id => state.hooks.push(['consent', id]) },
    '../services/appointmentAgendaOrigin.service': agenda,
    '../lib/access-policy': { getAccessibleClinicIdsForFeature: async ({ actorId, featureKey, clinicIds }) => actorId === 1
      || actorId === 2 && featureKey !== 'appointments.manage' ? clinicIds.filter(id => id === 100) : [] },
  });
  const express = require('express'), app = express(); app.use(express.json());
  app.use(load(require.resolve('../../routes/patientEconomics.routes'), {
    '../controllers/patientEconomics.controller': controller,
    './auth.middleware': (req, res, next) => { req.userData = { userId: Number(req.headers['x-owned-actor'] || 1) }; next(); },
  }));
  const server = require('node:http').createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); registerOwnedLoopbackServer(server);
  const send = (path, method = 'GET', body, actor = 1) => new Promise((resolve, reject) => {
    const request = require('node:http').request({ host: '127.0.0.1', port: server.address().port, path, method,
      headers: { 'Content-Type': 'application/json', 'x-owned-actor': String(actor) } }, response => {
      let bytes = ''; response.on('data', chunk => bytes += chunk); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(bytes) }));
    }); request.on('error', reject); request.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const path = `/budgets/${proposalBudget.public_id}/concepts/three-sessions/agenda-plan?clinic_id=100&patient_id=1`, beforeHttp = await counts();
    const response = await send(path); assert.equal(response.status, 200); assert.equal(response.body.source.budget_id, proposalBudget.public_id);
    assert.match(response.headers['cache-control'], /private.*no-store/); assert.deepEqual(await counts(), beforeHttp);
    assert.equal((await send(path.replace('clinic_id=100', 'clinic_id=200'))).status, 403);
    assert.equal((await send(path.replace('patient_id=1', 'patient_id=2'))).status, 404);
    assert.equal((await send(path, 'GET', undefined, 9)).status, 403);
    const bookingPath = path.split('/agenda-plan')[0] + '/agenda-appointments';
    const post = { clinic_id: 100, patient_id: 1, expected_version: 1, actorId: 3, request_key: crypto.randomUUID(),
      snapshot_sha256: response.body.snapshot_sha256, plan_revision: response.body.plan_revision,
      sessions: [{ key: 'pending_1', start_at: '2027-07-05T09:00Z', selections: { fixed: { doctor_id: 1, installation_id: 101 } }, priority_acknowledged: false }] };
    assert.equal((await send(bookingPath, 'POST', post, 2)).status, 403); assert.deepEqual(await counts(), beforeHttp);
    const saved = await send(bookingPath, 'POST', post); assert.equal(saved.status, 201); assert.equal(saved.body.data.request_key, post.request_key);
    assert.equal((await base.read(saved.body.data.sessions[0].appointment_id)).created_by, 1);
    state.durable = true;
    const cv = await db.PatientVoucher.create({ public_id: crypto.randomUUID(), patient_id: 3, clinic_id: 100, treatment_id: 4,
      name: 'Bono clásico con recibo ficticio', status: 'active', total_units: 2, available_units: 2, sold_amount: 200 });
    const cvPath = `/vouchers/${cv.public_id}/agenda-`, cvRead = (await send(cvPath + 'plan?clinic_id=100&patient_id=3')).body;
    const cvBody = { clinic_id: 100, patient_id: 3, request_key: crypto.randomUUID(), snapshot_sha256: cvRead.snapshot_sha256,
      plan_revision: cvRead.plan_revision, sessions: [{ key: 'pending_2', start_at: '2027-08-02T09:00Z',
        selections: { fixed: { doctor_id: 1, installation_id: 101 } }, priority_acknowledged: false }] };
    const cvBefore = await counts(), cvResponses = await Promise.all([send(cvPath + 'appointments', 'POST', cvBody), send(cvPath + 'appointments', 'POST', cvBody)]);
    assert.deepEqual(cvResponses.map(row => row.status).sort(), [200, 201]);
    assert.deepEqual(cvResponses[0].body.data.sessions, cvResponses[1].body.data.sessions);
    assert.equal(cvResponses[0].body.data.booking_request_key, cvBody.request_key);
    const cvSaved = cvResponses[0].body.data.sessions[0].appointment_id;
    assert.equal((await counts()).CitaPaciente, cvBefore.CitaPaciente + 1);
    assert.equal(state.hooks.filter(row => row[0] === 'consent' && row[1] === cvSaved).length, 1);
    assert.equal(state.hooks.filter(row => row[0] === 'realtime').length, 1);
    await cv.update({ status: 'consumed', available_units: 0 });
    const cvReplay = await send(cvPath + 'appointments', 'POST', cvBody); assert.equal(cvReplay.status, 200);
    assert.equal(cvReplay.body.data.replayed, true); assert.equal(cvReplay.body.documentation_review_required, true);
    assert.equal(state.hooks.filter(row => row[0] === 'consent' && row[1] === cvSaved).length, 1);
    report.checks.push('Classic voucher generic transport also reuses the existing durable prepared/committed receipt: concurrent HTTP confirms one real appointment and one replay. Native consent preparation/realtime happen once after the fresh ACK and never regenerate documents after lost-ACK replay or later consumed state.');
  } finally { await new Promise(resolve => server.close(resolve)); }
  report.checks.push('Actual generic agenda routes/controller enforce canonical clinic/patient scope, read/write ACL and portal denial with private no-store responses; payload actor spoofing does not replace the authenticated actor. Synthetic auth/ACL are explicit fixture boundaries; native scheduling and persistence remain real.');
  report.checks.push('The closed replay gate stays closed; native relative multi-phase treatment keeps explicit durations and complete capacity verification without pretending to be a voucher.');
  report.boundary = 'Native budget concept service, native series coordinator/solver/booking command and MySQL transactions; synthetic ACL and post-commit communication spies. Does not establish a browser session or send messages.';
}).catch(error => { console.error(error); process.exitCode = 1; });
