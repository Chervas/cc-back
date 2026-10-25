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
withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  const base = await createOwnedBookingDurationFixture({ sql, models: db, includePatientScope: true }), D = db.Sequelize.DataTypes;
  for (const file of ['patientvoucher', 'patientvouchermovement', 'patientoperationalevent', 'economicbudget', 'economicbudgetversion',
    'economicbudgetevent', 'economicpayment', 'patientwalletentry', 'economicfundingpart', 'economicconceptadjustment', 'economicfiscalcoverage', 'patientfiscaldocument']) {
    const model = require('../../../models/' + file)(sql, D); db[model.name] = model;
  }
  db.PatientOperationalEvent.options.indexes.forEach((row, i) => { row.name = ['idx_patient_operational_events_patient_type_at', 'idx_patient_operational_events_clinic_type_at', 'idx_patient_operational_events_actor_at'][i]; });
  await sql.sync();
  const profile = require('../../services/treatmentBookingProfile.service'), availability = require('../../services/appointmentBookingAvailability.service');
  const command = require('../../services/appointmentBookingCommand.service');
  const native = load(require.resolve('../../services/patientVoucherAppointments.service'), {
    '../../models': db,
    './appointmentAutomationV2Runtime.service': {},
    './treatmentBookingProfile.service': { ...profile, bookingCapabilities: () => base.capabilities,
      requireOperationalProfile: (treatment, options) => profile.requireOperationalProfile(treatment, { ...options, capabilities: base.capabilities }) },
    './appointmentBookingAvailability.service': { ...availability, loadBookingContext: options => availability.loadBookingContext({ ...options, equipmentEnabled: true }) },
    './appointmentBookingCommand.service': { mutateAppointmentBooking: options => command.mutateAppointmentBooking({ ...options, capabilities: base.capabilities }) },
  });
  const canAccess = async input => Number(input.actorId) < 3 && Number(input.clinicId) === 100;
  const concepts = require('../../services/economicConcepts.service').createService({ db, canAccess });
  const state = { durable: true, hooks: [] };
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
  state.durable = false;
  await assert.rejects(service.create(sealed), { code: 'budget_booking_replay_disabled' });
  const relative = await budget({ patient_id: 4, treatmentId: 2 });
  const relativeInput = input(relative, { start_at: '2030-02-04T09:00:00Z', count: 1, duration_minutes: undefined, doctor_id: undefined, installation_id: undefined, phase_durations: { one: 40, two: 20 } });
  const relativePlan = await service.preview(relativeInput);
  assert.equal(relativePlan.configuration.duration_minutes, 40); assert.equal(relativePlan.booking_replay_supported, false);
  assert.equal(relativePlan.booking_request_key, undefined); assert.equal(relativePlan.appointments[0].phases.length, 2);
  const relativeCreated = await service.create(relativeInput); assert.equal(relativeCreated.created.length, 1);
  assert.equal((await base.read(relativeCreated.created[0].id)).voucher_id, null); assert.equal((await base.occupancy(relativeCreated.created[0].id)).length, 4);
  report.checks.push('The closed replay gate stays closed; native relative multi-phase treatment keeps explicit durations and complete capacity verification without pretending to be a voucher.');
  report.boundary = 'Native budget concept service, native series coordinator/solver/booking command and MySQL transactions; synthetic ACL and post-commit communication spies. Does not establish a browser session or send messages.';
}).catch(error => { console.error(error); process.exitCode = 1; });
