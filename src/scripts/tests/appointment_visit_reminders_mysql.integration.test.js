'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitReminderFixture } = require('./helpers/owned-visit-reminder-fixture');

test('new visits and voucher bookings freeze native reminder stages and recover due intents through actual scheduler/job/flow/broker',
  { skip: process.env.APPOINTMENT_VISIT_REMINDERS_MYSQL_TEST !== '1', timeout: 180000 }, async () => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createOwnedVisitReminderFixture(context), { db } = f;
      try {
        const intents = id => db.AppointmentVisitCommunication.findAll({ where: { owner_appointment_id: id }, order: [['purpose', 'ASC'], ['communication_revision', 'ASC']] });
        const intentFor = (id, purpose, revision = 1) => db.AppointmentVisitCommunication.findOne({ where: { owner_appointment_id: id, purpose, communication_revision: revision } });
        const create = async (date, patient = 1) => {
          const response = await f.post(f.body({ inicio: date + 'T09:00:00Z', paciente: { id_paciente: patient } }));
          assert.equal(response.statusCode, 201, JSON.stringify(response.body)); assert.equal(response.body.booking_request_replay_supported, true);
          return Number(response.body.id_cita);
        };
        const materialize = async intent => {
          await intent.reload(); assert(intent.execution_id, 'native execution required');
          const execute = await db.JobRequest.findOne({ where: { type: 'automations_v2_execute', payload: { execution_id: Number(intent.execution_id) } } }); assert(execute);
          const handled = await f.claimAndHandle(execute.id); assert.equal(handled.status, 'waiting', JSON.stringify(handled));
          await intent.reload(); const message = await db.Message.findByPk(intent.message_id); assert(message); assert.equal(message.sent_at, null);
          const job = await db.JobRequest.findOne({ where: { type: 'appointment_visit_dispatch', payload: { visit_communication_id: intent.id } } }); assert(job);
          return { intent, execute, message, job };
        };
        const visitFor = async id => db.AppointmentVisit.findByPk((await db.AppointmentVisitMember.findByPk(id)).visit_id);
        const first = await create('2030-01-07'), rights = await intents(first);
        assert.equal(rights.length, 3); assert.equal(rights.filter(row => row.purpose.startsWith('reminder_')).length, 2);
        const visit = await visitFor(first), appointment = await db.CitaPaciente.findByPk(first);
        assert.equal(visit.runtime_enrollment.reminder_bindings.length, 2);
        assert.equal(visit.runtime_enrollment.reminder_booked_at, appointment.created_at.toISOString());
        const day = await intentFor(first, 'reminder_day_before'), same = await intentFor(first, 'reminder_same_day');
        assert.equal(day.window_starts_at.toISOString(), '2030-01-06T08:00:00.000Z');
        assert.equal(day.window_ends_at.toISOString(), '2030-01-06T08:15:00.000Z');
        assert.equal(same.window_starts_at.toISOString(), '2030-01-07T08:00:00.000Z');
        assert.equal(day.execution_id, null); assert.equal(same.execution_id, null);
        assert.equal(visit.snapshot.reservations[0].booking.steps.length, 2);
        const detail = await materialize(await intentFor(first, 'appointment_details'));
        assert.equal((await f.claimAndHandle(detail.job.id)).result.outcome, 'accepted');
        assert.equal(f.attempts.length, 1);
        context.report.checks.push('Actual createCita HTTP/canonical writer/SQL birth freezes real selector graphs + normalized timing/grace + native Cita.created_at; two physical steps have one details, one day-before and one same-day right in the SAME aggregate transaction');

        f.clock('2030-01-06T07:59:59Z'); await f.tick(); await day.reload(); assert.equal(day.execution_id, null);
        const before = await db.FlowExecutionV2.count();
        const early = await f.runtime.enqueueExecutionForCita(appointment, { event_name: 'appointment_reminder_window', visit_communication_id: day.id });
        assert.equal(early.reason, 'visit_reminder_not_due'); assert.equal(await db.FlowExecutionV2.count(), before);
        // Concurrent independently reconstructed publishers and scheduler ticks
        // must all converge on the same native intent/execution/job.
        f.clock('2030-01-06T08:00:00Z'); f.restartManaged();
        await Promise.all([f.tick(), f.tick(), f.managed.reconcilePendingBirthIntents({ runtimeNamespace: 'visit_fixture', limit: 100 })]);
        await day.reload(); assert(day.execution_id); assert.equal((await same.reload()).execution_id, null);
        assert.equal(await db.FlowExecutionV2.count({ where: { idempotency_key: 'visit-stage:' + day.id } }), 1);
        const dayItem = await materialize(day); assert.equal((await f.claimAndHandle(dayItem.job.id)).result.outcome, 'accepted');
        const attempts = f.attempts.length; await f.jobs.setPending(dayItem.job.id);
        assert.equal((await f.claimAndHandle(dayItem.job.id)).result.reason, 'accepted'); assert.equal(f.attempts.length, attempts);
        await f.tick(); assert.equal(await db.Message.count({ where: { automation_delivery_key: dayItem.message.automation_delivery_key } }), 1);
        context.report.checks.push('Actual existing criticalTick at08:00 (09:00 Europe/Madrid), restart and concurrent discovery publish one day-before execution/job/Message/fake send;07:59:59 is denied, same-day remains future, accepted dispatch cannot repeat');

        f.clock('2030-01-07T08:00:00Z'); await f.tick();
        const sameItem = await materialize(await same.reload()); f.provider('unknown');
        assert.equal((await f.claimAndHandle(sameItem.job.id)).result.outcome, 'unknown');
        const unknownAttempts = f.attempts.length; await f.jobs.setPending(sameItem.job.id);
        assert.equal((await f.claimAndHandle(sameItem.job.id)).result.reason, 'unknown'); assert.equal(f.attempts.length, unknownAttempts); f.provider('accept');
        assert.equal((await f.patch(first, 'state', { estado: 'cancelada' })).statusCode, 200);
        assert.equal((await day.reload()).status, 'accepted'); assert.equal((await same.reload()).status, 'unknown');
        context.report.checks.push('Details acceptance and one day-before acceptance do not suppress the independent same-day purpose; fake network uncertainty reserves that same right permanently and retry does not transport again');

        // NEW voucher appointment, not adopting its old imported purchase.
        f.clock('2030-01-01T12:00:00Z'); const voucher = await f.voucher({ patient_id: 2, source_system: 'cliniccloud' });
        const input = f.payload({ start_at: '2030-01-08T09:00:00Z' });
        const preview = await f.request(voucher, 'appointment-plan', input); assert.equal(preview.status, 200, JSON.stringify(preview));
        f.state.crashBeforeEnqueue = true;
        await assert.rejects(f.request(voucher, 'appointments', f.seal(input, preview.body), { drop: true }), { code: 'ECONNRESET' });
        f.state.crashBeforeEnqueue = false;
        const voucherAppointment = await db.CitaPaciente.findOne({ where: { voucher_id: voucher.id } }); assert(voucherAppointment);
        const voucherVisit = await visitFor(voucherAppointment.id_cita); assert(voucherVisit.runtime_enrollment.origin);
        const voucherDay = await intentFor(voucherAppointment.id_cita, 'reminder_day_before'); assert(voucherDay); assert.equal(voucherDay.execution_id, null);
        const hooks = f.state.hooks.length;
        assert.equal((await f.request(voucher, 'appointments', f.seal(input, preview.body))).status, 200); assert.equal(f.state.hooks.length, hooks);
        const publicationsBefore = f.publication.length;
        f.clock('2030-01-07T08:05:00Z'); f.restartManaged(); await Promise.all([f.tick(), f.tick()]);
        await voucherDay.reload(); assert(voucherDay.execution_id);
        const firstRecoveredJob = await db.JobRequest.findByPk(f.publication[publicationsBefore]);
        assert.equal(Number(firstRecoveredJob.payload.execution_id), Number(voucherDay.execution_id), 'due reminder lane precedes pending details backlog');
        const voucherItem = await materialize(voucherDay); assert.equal((await f.claimAndHandle(voucherItem.job.id)).result.outcome, 'accepted');
        assert.equal(await db.AppointmentVisitCommunication.count({ where: { owner_appointment_id: voucherAppointment.id_cita, purpose: 'reminder_day_before' } }), 1);
        context.report.checks.push('Imported original voucher purchase creates NEW source-free native booking with verified origin; lost HTTP response BEFORE enqueue preserves reminder intent; parent replay runs no hooks, restart criticalTick discovers due persisted reminder once within original15min grace');

        f.clock('2030-01-01T12:00:00Z');
        const moved = await create('2030-01-09', 3), old = await intentFor(moved, 'reminder_day_before');
        const movedRow = await db.CitaPaciente.findByPk(moved), reservedMs = +new Date(movedRow.fin) - +new Date(movedRow.inicio);
        for (const inicio of ['2030-01-09T10:00:00Z', '2030-01-09T09:00:00Z']) {
          const response = await f.patch(moved, 'move', { inicio, fin: new Date(Date.parse(inicio) + reservedMs).toISOString(),
            reschedule_reason: 'administrative_error', doctor_id: 1, instalacion_id: 101 });
          assert.equal(response.statusCode, 200, JSON.stringify(response));
        }
        assert.equal((await visitFor(moved)).communication_revision, 3); assert.equal((await old.reload()).status, 'cancelled');
        const newest = await intentFor(moved, 'reminder_day_before', 3); assert(newest); assert(newest.runtime_stage.mutation_event_id);
        assert.equal(await db.AppointmentVisitCommunication.count({ where: { owner_appointment_id: moved, purpose: 'appointment_details', communication_revision: 3 } }), 0);
        f.clock('2030-01-08T08:00:00Z'); await f.tick(); assert((await newest.reload()).execution_id); assert.equal((await old.reload()).execution_id, null);
        const newestItem = await materialize(newest); assert.equal((await f.claimAndHandle(newestItem.job.id)).result.outcome, 'accepted');
        context.report.checks.push('Actual movement endpoint A→B→A gives revisions1→3, old reminders remain cancelled even at identical old time; administrative_error suppresses immediate details ONLY, current reminder carries verified append-only mutation anchor and sends once');

        f.clock('2030-01-01T12:00:00Z'); const cancelled = await create('2030-01-10', 4), cancelDay = await intentFor(cancelled, 'reminder_day_before');
        assert.equal((await f.patch(cancelled, 'state', { estado: 'cancelada' })).statusCode, 200);
        f.clock('2030-01-09T08:00:00Z'); await f.tick(); assert.equal((await cancelDay.reload()).status, 'cancelled'); assert.equal(cancelDay.execution_id, null);
        context.report.checks.push('Actual state cancellation retires pending reminder rights and due discovery does not recreate them; accepted/unknown rights of other visits remain unchanged');

        // Final revalidation after a reminder was materialized, not just discovery.
        f.clock('2030-01-01T12:00:00Z'); const held = await create('2030-01-11', 4), heldDay = await intentFor(held, 'reminder_day_before');
        f.clock('2030-01-10T08:00:00Z'); await f.tick(); const heldItem = await materialize(heldDay);
        const heldAppointment = await db.CitaPaciente.findByPk(held), original = heldAppointment.import_metadata;
        await heldAppointment.update({ import_metadata: { ...original, automation_policy: 'hold' } });
        const heldAttempts = f.attempts.length; const heldResult = await f.claimAndHandle(heldItem.job.id);
        assert.equal(heldResult.executorStatus, 'failed', JSON.stringify(heldResult)); assert.equal(f.attempts.length, heldAttempts);
        await heldAppointment.update({ import_metadata: original });
        context.report.checks.push('Fresh HOLD introduced after actual flow/Message materialization is reread by final native dispatch/broker guard; no fake provider attempt occurs');

        f.clock('2030-01-01T12:00:00Z'); const changed = await create('2030-01-14', 4), changedDay = await intentFor(changed, 'reminder_day_before');
        const template = await db.AutomationFlowTemplateV2.findByPk(45), config = template.trigger_config;
        await template.update({ trigger_config: { ...config, custom_time: '10:00' } });
        f.clock('2030-01-13T08:00:00Z'); await f.tick(); assert.equal((await changedDay.reload()).execution_id, null);
        await template.update({ trigger_config: config });
        const selectedWinner = await db.AutomationFlowTemplateV2.create({ ...template.toJSON(), id: 47,
          public_id: 'owned_visit_reminder_new_version', version: 2, published_at: new Date('2030-01-01T12:00:00Z') });
        await f.tick(); assert.equal((await changedDay.reload()).execution_id, null);
        await selectedWinner.destroy();
        const clinic = await db.Clinica.findByPk(100), clinicConfig = clinic.configuracion;
        await clinic.update({ configuracion: { ...clinicConfig, timezone: 'UTC' } }); await f.tick(); assert.equal((await changedDay.reload()).execution_id, null);
        await clinic.update({ configuracion: clinicConfig });
        await db.Tratamiento.update({ automation_template_bindings: { appointment_before: { disabled: true } } }, { where: { id_tratamiento: 2 } });
        await f.tick(); assert.equal((await changedDay.reload()).execution_id, null);
        await db.Tratamiento.update({ automation_template_bindings: {} }, { where: { id_tratamiento: 2 } });
        f.registry([]); await f.tick(); assert.equal((await changedDay.reload()).execution_id, null); f.restoreRegistry();
        f.clock('2030-01-13T08:15:00Z'); await f.tick(); assert.equal((await changedDay.reload()).execution_id, null);
        context.report.checks.push('Current graph/time configuration change, newly selected version winner, current clinic timezone change, disabled selected treatment binding and missing review registry all hold existing intent; at grace expiry it is never re-windowed or sent late');

        const condition = await db.AutomationFlowTemplateV2.findByPk(45);
        await condition.update({ trigger_config: { ...condition.trigger_config, exclude_if_not_confirmed: true } }); await f.refreshRegistry();
        f.clock('2030-01-01T12:00:00Z'); const unconfirmed = await create('2030-01-15', 4), conditional = await intentFor(unconfirmed, 'reminder_day_before'); assert(conditional);
        f.clock('2030-01-14T08:00:00Z'); await f.tick(); assert.equal((await conditional.reload()).execution_id, null);
        await db.CitaPaciente.update({ estado: 'info_confirmada' }, { where: { id_cita: unconfirmed } }); await f.tick(); assert((await conditional.reload()).execution_id);
        context.report.checks.push('Native exclude_if_not_confirmed preserves schedule-vs-fire semantics: unconfirmed birth still freezes future intent; due unconfirmed is held, current confirmed state allows same original due intent without an extra claim');

        f.clock('2030-01-01T12:00:00Z'); const lateChange = await create('2030-01-17', 4);
        await db.CitaPaciente.update({ estado: 'info_confirmada' }, { where: { id_cita: lateChange } });
        f.clock('2030-01-16T08:00:00Z'); await f.tick(); const lateItem = await materialize(await intentFor(lateChange, 'reminder_day_before'));
        const originalConfig = (await condition.reload()).trigger_config;
        await condition.update({ trigger_config: { ...originalConfig, custom_time: '10:00' } });
        const lastAttempts = f.attempts.length, lateResult = await f.claimAndHandle(lateItem.job.id);
        assert.equal(lateResult.executorStatus, 'failed', JSON.stringify(lateResult)); assert.equal(f.attempts.length, lastAttempts);
        await condition.update({ trigger_config: originalConfig });
        context.report.checks.push('Reminder already has real execution/Message/dispatch job before config changes: final current selector/graph/policy guard denies transport, not only discovery; provider attempts remain unchanged');

        // Prove all intents/physical rows roll back, not only simulation counts.
        f.clock('2030-01-01T12:00:00Z'); const count = await f.counts(), createIntent = db.AppointmentVisitCommunication.create;
        db.AppointmentVisitCommunication.create = async function(values, options) {
          const row = await createIntent.call(this, values, options); if (values.purpose === 'reminder_same_day') throw Error('OWNED_AFTER_REMINDER_INSERT'); return row;
        };
        try { assert.equal((await f.post(f.body({ inicio: '2030-01-16T09:00:00Z', paciente: { id_paciente: 4 } }))).statusCode, 500); }
        finally { db.AppointmentVisitCommunication.create = createIntent; }
        assert.deepEqual(await f.counts(), count);
        context.report.checks.push('Native failure AFTER reminder INSERT rolls back all canonical Cita/physical occupancy/member/visit/birth receipt/details+reminder intentions; no postcommit publication runs');

        f.enable(false); const closedCount = await db.JobRequest.count(), query = db.sequelize.query; let closedSql = 0;
        db.sequelize.query = function(...args) { closedSql++; return query.apply(this, args); };
        let closed;
        try { closed = await f.managed.reconcilePendingBirthIntents({ runtimeNamespace: 'visit_fixture' }); }
        finally { db.sequelize.query = query; }
        assert.equal(closed.reason, 'visit_rollout_closed'); assert.equal(closedSql, 0); assert.equal(await db.JobRequest.count(), closedCount);
        assert.deepEqual(require('../../config/appointmentVisitRuntimeManifests'), []);
        context.report.checks.push('Default registry remains empty and rollout remains unactivated; closed discovery returns before scheduling SQL/work; real app authentication and actual WhatsApp/tablet delivery are not asserted');
        context.report.fakeProviderAttempts = f.attempts.length;
      } finally { await f.close(); }
    });
  });
