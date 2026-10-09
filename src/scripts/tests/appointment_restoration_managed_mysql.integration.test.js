'use strict';
const assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitMutationFixture } = require('./helpers/owned-visit-mutation-fixture');
withIsolatedCampaignMysql(async owned => {
  const f = await createOwnedVisitMutationFixture(owned), { db } = f;
  Object.assign(process.env, { BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true', BOOKING_PHASE_OFFSETS_ENABLED: 'true' });
  try {
    const result = await f.post(f.body({ inicio: '2030-01-07T09:00:00Z' }));
    assert.equal(result.statusCode, 201, JSON.stringify(result.body));
    const id = result.body.id_cita;
    const member = await db.AppointmentVisitMember.findByPk(id), visit = await db.AppointmentVisit.findByPk(member.visit_id);
    const cancelled = await f.patch(id, 'state', { estado: 'cancelada' });
    assert.equal(cancelled.statusCode, 200, JSON.stringify(cancelled.body));
    const afterCancel = {};
    for (const name of ['Message', 'FlowExecutionV2', 'JobRequest', 'AppointmentVisitCommunication', 'AppointmentVisitDispatch'])
      afterCancel[name] = await db[name].count();
    await visit.reload(); const revision = visit.communication_revision;
    const R = require('../../services/appointmentRestoration.service');
    const p = await R.previewRestoration({ db, appointmentId: id, actorId: 1 });
    assert.equal(p.can_restore, true, JSON.stringify(p));
    const restored = await R.restoreAppointment({ db, appointmentId: id, actorId: 1, acknowledgement: p.restoration_acknowledgement });
    assert.equal(restored.selected.estado, 'pendiente');
    await visit.reload(); assert.equal(visit.communication_revision, revision + 1);
    for (const [name, count] of Object.entries(afterCancel)) assert.equal(await db[name].count(), count, name + ' remains silent');
    const intents = await db.AppointmentVisitCommunication.findAll({ where: { visit_id: visit.id } });
    assert(intents.every(intent => intent.status === 'cancelled'), 'No retired flow regains a communication right');
    // Locate by the native runtime constant; do not depend on a display label.
    const events = await db.PatientOperationalEvent.findAll({ where: { event_type: require('../../lib/appointment-visit-runtime-contract').MUTATION_EVENT }, order: [['id', 'DESC']] });
    assert.equal(events[0].metadata.mutation.suppressed, true);
    assert.equal(events[0].metadata.mutation.kind, 'rescheduled');
    const beforeDiscover = await db.JobRequest.count();
    await f.managed.reconcilePendingBirthIntents({ runtimeNamespace: 'visit_fixture', limit: 10 });
    assert.equal(await db.JobRequest.count(), beforeDiscover, 'Discovery cannot revive an old pending notice');
    assert.equal(f.attempts.length, 0);
    owned.report.checks.push('Rollout enabled: native managed visit revision advances, old rights retire, suppressed receipt records silent restoration; zero new flows/messages/jobs/reminders or provider attempts, including discovery');
  } finally { await f.close(); }
}).catch(error => { console.error(error); process.exitCode = 1; });
