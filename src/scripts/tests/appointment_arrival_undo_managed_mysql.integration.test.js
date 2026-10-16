'use strict';

// Actual canonical native combined birth, arrival and silent undo over a newly
// OWNED MySQL. Declared fixture boundary: synthetic ACL/UI read helpers and
// in-process provider transport; no worker is started and no send is attempted.
const assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitMutationFixture } = require('./helpers/owned-visit-mutation-fixture');

withIsolatedCampaignMysql(async owned => {
  const f = await createOwnedVisitMutationFixture(owned), { db } = f;
  db.AppointmentCareEvent = require('../../../models/appointmentcareevent')(f.sql, S.DataTypes);
  await db.AppointmentCareEvent.sync();
  Object.assign(process.env, { BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true', BOOKING_PHASE_OFFSETS_ENABLED: 'true' });
  try {
    // A genuine future birth relative to the fixture's logical booking clock;
    // it has reached its actual appointment day when reception records arrival.
    f.clock('2026-10-12T08:00:00Z');
    const created = await f.post(f.body({ inicio: '2026-10-12T10:00:00Z' }));
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
    const id = created.body.id_cita, member = await db.AppointmentVisitMember.findByPk(id);
    assert(member, 'The test exercises a truly enrolled native managed visit');
    const visit = await db.AppointmentVisit.findByPk(member.visit_id), enrollment = visit.runtime_enrollment_sha256;
    assert(visit.runtime_enrollment);
    const initialRevision = Number(visit.communication_revision);
    const occupancy = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: id }, order: [['id', 'ASC']], raw: true });
    assert(occupancy.length > 1, 'The reservation keeps the real multi-resource treatment');
    const care = await require('../../services/appointmentCare.service').record({ appointmentId: id, clinicId: 100, actorId: 1, action: 'arrive' });
    assert.equal(care.appointment.estado, 'ha_acudido'); assert(care.confirmation_undo);
    await visit.reload(); assert.equal(Number(visit.communication_revision), initialRevision + 1);
    assert.equal(visit.snapshot.reservations[0].lifecycle, 'ha_acudido');
    const afterArrival = {};
    for (const name of ['Message', 'FlowExecutionV2', 'JobRequest', 'AppointmentVisitCommunication', 'AppointmentVisitDispatch'])
      afterArrival[name] = await db[name].count();
    const restored = await require('../../services/appointmentConfirmationUndo.service').createAppointmentConfirmationUndoService({ db }).undo({
      appointmentId: id, changeId: care.confirmation_undo.change_id, clinicId: 100, actorId: 1,
    });
    assert.equal(restored.appointment.estado, 'pendiente'); assert.equal(restored.appointment.arrived_at, null);
    await visit.reload();
    assert.equal(Number(visit.communication_revision), initialRevision + 2);
    assert.equal(visit.snapshot.reservations[0].lifecycle, 'active');
    assert.equal(visit.runtime_enrollment_sha256, enrollment, 'Existing approved enrollment remains immutable');
    assert.deepEqual(await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: id }, order: [['id', 'ASC']], raw: true }), occupancy);
    for (const [name, count] of Object.entries(afterArrival)) assert.equal(await db[name].count(), count, name + ' remains silent');
    const intents = await db.AppointmentVisitCommunication.findAll({ where: { visit_id: visit.id } });
    assert(intents.length > 0 && intents.every(intent => intent.status === 'cancelled'), 'Arrival retirement is never undone into old dispatch rights');
    const eventType = require('../../lib/appointment-visit-runtime-contract').MUTATION_EVENT;
    const events = await db.PatientOperationalEvent.findAll({ where: { event_type: eventType }, order: [['id', 'ASC']] });
    assert.equal(events.length, 2);
    assert(events.every(event => event.metadata.mutation.suppressed === true));
    const jobs = await db.JobRequest.count();
    await f.managed.reconcilePendingBirthIntents({ runtimeNamespace: 'visit_fixture', limit: 10 });
    assert.equal(await db.JobRequest.count(), jobs, 'A recovery sweep cannot revive the old birth notice after undo');
    assert.equal(f.attempts.length, 0);
    owned.report.checks.push('Real enrolled multi-resource visit: native arrival and inverse advance canonical projections under the same SQL transactions, preserve enrollment and booking capacities, retire old notices, create no new message/flow/job/intent/provider attempt, and discovery cannot revive an old notice');
  } finally { await f.close(); }
}).catch(error => { console.error(error); process.exitCode = 1; });
