'use strict';

// Explicit opt-in; only newly owned MySQL/socket/HTTP server and fake broker
// transport. Never app bootstrap, real DB/Redis/provider or rollout activation.
const test = require('node:test'), assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitConsumerFixture } = require('./helpers/owned-visit-consumer-fixture');

test('managed birth lane: actual endpoint/command/runtime/Message/job handler/final broker with owned SQL',
  { skip: process.env.APPOINTMENT_VISIT_CONSUMERS_MYSQL_TEST !== '1', timeout: 180000 }, async () => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createOwnedVisitConsumerFixture(context), { db } = f;
      try {
        const preview = await f.physical.http('treatmentSlots', { tratamiento_id: '2', duration_minutes: undefined,
          phase_durations: JSON.stringify({ one: 40, two: 20 }), paciente_id: '1' });
        assert.equal(preview.statusCode, 200);
        const slot = preview.body.slots.find(row => row.start_utc === '2030-01-07T09:00:00.000Z'); assert(slot);
        const body = f.body({ booking_plan_sha256: slot.booking_plan_sha256 }), first = await f.post(body);
        assert.equal(first.statusCode, 201, JSON.stringify(first.body));
        assert.equal(first.body.booking_request_replay_supported, true);
        assert.equal(first.body.booking_request_replayed, false);
        const id = first.body.id_cita;
        const repeats = await Promise.all(Array.from({ length: 4 }, () => f.post(body)));
        for (const repeat of repeats) { assert.equal(repeat.statusCode, 201, JSON.stringify(repeat.body)); assert.equal(repeat.body.id_cita, id); assert.equal(repeat.body.booking_request_replayed, true); }
        assert.equal(await db.CitaPaciente.count(), 1); assert.equal(await db.AppointmentVisit.count(), 1);
        assert.equal(await db.AppointmentVisitBirthRequest.count(), 1); assert.equal(await db.AppointmentVisitCommunication.count(), 1);
        assert.equal(await db.FlowExecutionV2.count(), 1); assert.equal(await db.JobRequest.count({ where: { type: 'automations_v2_execute' } }), 1);
        context.report.checks.push('Actual loopback POST -> real createCita/command/solver/SQL: exact same transport body repeated concurrently preserves one canonical appointment, visit, birth receipt, intent, execution and JobRequest');
        const execute = await db.JobRequest.findOne({ where: { type: 'automations_v2_execute' } });
        const materialized = await f.claimAndHandle(execute.id);
        assert.equal(materialized.status, 'waiting', JSON.stringify(materialized));
        const intent = await db.AppointmentVisitCommunication.findOne(), message = await db.Message.findByPk(intent.message_id);
        const currentFlow = await db.FlowExecutionV2.findByPk(execute.payload.execution_id);
        assert(message, 'actual flow engine binds Message: ' + JSON.stringify({ node: currentFlow.current_node_id, status: currentFlow.status, wait: currentFlow.waiting_meta, error: currentFlow.last_error }));
        assert.equal(message.automation_delivery_key, 'visit-communication:' + intent.id);
        const deliver = await db.JobRequest.findOne({ where: { type: 'appointment_visit_dispatch' } }); assert(deliver);
        assert.equal(message.sent_at, null); assert.equal(intent.status, 'pending');
        const receipt = await f.claimAndHandle(deliver.id);
        assert.equal(receipt.result.outcome, 'accepted', JSON.stringify(receipt));
        assert.equal(f.attempts.length, 1); assert.equal((await db.Message.findByPk(message.id)).status, 'pending');
        assert.equal((await db.Message.findByPk(message.id)).sent_at, null);
        assert.equal((await db.AppointmentVisitCommunication.findByPk(intent.id)).status, 'accepted');
        await f.jobs.setPending(deliver.id);
        const again = await f.claimAndHandle(deliver.id); assert.equal(again.result.reason, 'accepted'); assert.equal(f.attempts.length, 1);
        assert.equal(await f.claimAndHandle(execute.id), null, 'waiting JobRequest is not claimable before its real persisted next_run_at');
        await execute.update({ next_run_at: new Date(Date.now() - 1000) }); // Owned clock advances to due, no sleep/worker activation.
        const stillWaiting = await f.claimAndHandle(execute.id); assert.equal(stillWaiting.status, 'waiting', JSON.stringify(stillWaiting));
        assert.equal(f.attempts.length, 1, 'accepted provider receipt never requeues transport or fabricates an effective send clock');
        const sentAt = new Date('2026-10-07T12:00:00.123Z');
        // Explicit factual receipt on the OWNED row. This exercises real flow
        // resume, not the webhook consumer, which remains separately scoped.
        await message.reload(); await message.update({ status: 'sent', sent_at: sentAt });
        await execute.update({ next_run_at: new Date(Date.now() - 1000) });
        const resumed = await f.claimAndHandle(execute.id); assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
        assert.equal((await db.FlowExecutionV2.findByPk(execute.payload.execution_id)).context.outputs.S.effective_send_at, sentAt.toISOString().replace('.123', '.000'));
        assert.equal(await db.Message.count({ where: { automation_delivery_key: message.automation_delivery_key } }), 1);
        context.report.checks.push('Real preview receipt with implicit attention -> SQL birth -> exact POST replay; actual flow materializes stable-key Message with sent_at null; real dispatch/common sender/broker accept one fake attempt; native waiting job polls until factual sent receipt, then resumes with that clock');

        let serial = 0;
        const nextBody = (patch = {}) => {
          const index = serial++, date = new Date(Date.UTC(2030, 0, 8, 8 + index % 9));
          for (let days = Math.floor(index / 9); days > 0;) {
            date.setUTCDate(date.getUTCDate() + 1); if (![0, 6].includes(date.getUTCDay())) days--;
          }
          return f.body({ inicio: date.toISOString(), ...patch });
        };
        const create = async patch => {
          const input = nextBody(patch), response = await f.post(input);
          assert.equal(response.statusCode, 201, JSON.stringify(response.body)); assert.equal(response.body.booking_request_replay_supported, true);
          const intent = await db.AppointmentVisitCommunication.findOne({ where: { owner_appointment_id: response.body.id_cita } });
          assert(intent);
          const execute = await db.JobRequest.findOne({ where: { type: 'automations_v2_execute', payload: { execution_id: Number(intent.execution_id) } } });
          assert(execute);
          return { input, response, intent, execute };
        };
        const materialize = async item => {
          const result = await f.claimAndHandle(item.execute.id); assert.equal(result.status, 'waiting', JSON.stringify(result));
          await item.intent.reload(); item.message = await db.Message.findByPk(item.intent.message_id); assert(item.message); assert.equal(item.message.sent_at, null);
          item.deliver = await db.JobRequest.findOne({ where: { type: 'appointment_visit_dispatch', payload: { visit_communication_id: item.intent.id } } }); assert(item.deliver);
          return item;
        };
        const attemptsBefore = () => f.attempts.length;
        // Race the FIRST transport, not only retries after a receipt exists.
        const raceBody = nextBody(), before = await db.CitaPaciente.count();
        const race = await Promise.all(Array.from({ length: 4 }, () => f.post(raceBody)));
        for (const response of race) assert.equal(response.statusCode, 201, JSON.stringify(response.body));
        assert.equal(new Set(race.map(row => row.body.id_cita)).size, 1);
        assert.equal(race.filter(row => row.body.booking_request_replayed === false).length, 1);
        assert.equal(await db.CitaPaciente.count(), before + 1);
        const conflict = await f.post({ ...raceBody, paciente: { id_paciente: 2 } }); assert.equal(conflict.statusCode, 409);
        assert.equal(conflict.body.code, 'appointment_visit_runtime_birth_request_conflict');
        const phaseConflict = await f.post({ ...raceBody, booking_selection: { ...raceBody.booking_selection, two: { doctor_id: 1, installation_id: 102 } } });
        assert.equal(phaseConflict.statusCode, 409); assert.equal(await db.CitaPaciente.count(), before + 1);
        context.report.checks.push('Four first POSTs race under actual booking resource locks: one canonical birth; exact transport replay preserves hash; same key with different patient or selected phase conflicts without new writes');

        const closed = await materialize(await create()); f.enable(false);
        const closedReplay = await f.post(closed.input); assert.equal(closedReplay.statusCode, 201); assert.equal(closedReplay.body.id_cita, closed.response.body.id_cita);
        const closedAttempt = attemptsBefore(), closedResult = await f.claimAndHandle(closed.deliver.id);
        assert.equal(closedResult.executorStatus, 'failed'); assert.equal(f.attempts.length, closedAttempt);
        assert.equal(await db.AppointmentVisitDispatch.count({ where: { communication_id: closed.intent.id } }), 0);
        const closedPublish = await f.runtime.enqueueExecutionForCita(await db.CitaPaciente.findByPk(closed.response.body.id_cita), { event_name: 'appointment_created' });
        assert.equal(closedPublish.reason, 'visit_rollout_closed'); assert.equal(closedPublish.managed, true);
        f.enable(true);
        context.report.checks.push('Rollout closure preserves enrolled identity-only POST replay and prevents real dispatch lease/publication with no legacy fallback');

        const held = await materialize(await create()); f.provider('held');
        const heldBefore = attemptsBefore(), heldResult = await f.claimAndHandle(held.deliver.id); assert.equal(heldResult.result.outcome, 'accepted');
        await held.message.reload(); assert.equal(held.message.status, 'pending'); assert.equal(held.message.sent_at, null);
        assert.equal(held.message.metadata.provider_acceptance_status, 'held_for_quality_assessment');
        await held.execute.update({ next_run_at: new Date(Date.now() - 1000) });
        const heldResume = await f.claimAndHandle(held.execute.id); assert.equal(heldResume.status, 'waiting');
        assert.equal((await db.FlowExecutionV2.findByPk(held.intent.execution_id)).context.outputs.S.effective_send_at, undefined);
        await f.jobs.setPending(held.deliver.id); assert.equal((await f.claimAndHandle(held.deliver.id)).result.reason, 'accepted');
        assert.equal(f.attempts.length, heldBefore + 1); f.provider('accept');
        context.report.checks.push('Meta held_for_quality_assessment reserves accepted intent but Message remains pending/sent_at null; actual flow waits without response clock and dispatch retry never sends again');

        const uncertain = await materialize(await create()); f.provider('unknown');
        const uncertainBefore = attemptsBefore(), uncertainResult = await f.claimAndHandle(uncertain.deliver.id); assert.equal(uncertainResult.result.outcome, 'unknown');
        await uncertain.message.reload(); assert.equal(uncertain.message.metadata.delivery_unknown, true); assert.equal(uncertain.message.sent_at, null);
        await f.jobs.setPending(uncertain.deliver.id); assert.equal((await f.claimAndHandle(uncertain.deliver.id)).result.reason, 'unknown');
        assert.equal(f.attempts.length, uncertainBefore + 1); assert.equal((await f.post(uncertain.input)).body.id_cita, uncertain.response.body.id_cita);
        f.provider('accept');
        assert.equal((await f.dispatch.cancelIntent({ communicationId: uncertain.intent.id, clinicId: 100, reason: 'owned_cancel' })).cancelled, false);
        context.report.checks.push('Fake network ambiguity after private network mark persists unknown; actual handler/POST retries and cancellation preserve same Message/intent/history with no second attempt');

        const denied = await materialize(await create()); f.blocked(true);
        const deniedBefore = attemptsBefore(), deniedResult = await f.claimAndHandle(denied.deliver.id); assert.equal(deniedResult.executorStatus, 'failed');
        const deniedDispatch = await db.AppointmentVisitDispatch.findOne({ where: { communication_id: denied.intent.id } });
        assert.equal(deniedDispatch.status, 'pre_dispatch_failed'); assert.equal(deniedDispatch.network_started_at, null);
        await denied.intent.reload(); await denied.message.reload(); assert.equal(denied.intent.status, 'failed'); assert.equal(denied.message.metadata.delivery_unknown, undefined);
        assert.equal(f.attempts.length, deniedBefore); f.blocked(false);
        await f.jobs.setPending(denied.deliver.id); const deniedRetry = await f.claimAndHandle(denied.deliver.id); assert.equal(deniedRetry.result.outcome, 'accepted');
        assert.equal(f.attempts.length, deniedBefore + 1); await denied.intent.reload(); assert.equal(denied.intent.message_id, denied.message.id);
        assert.equal(await db.Message.count({ where: { automation_delivery_key: denied.message.automation_delivery_key } }), 1);
        context.report.checks.push('Real scope guard before transport settles definite pre-network failure, not unknown; next actual job attempt uses SAME Message/stable key and accepts only once after guard removal');

        const cancelled = await materialize(await create()); const cancelledBefore = attemptsBefore();
        assert.equal((await f.dispatch.cancelIntent({ communicationId: cancelled.intent.id, clinicId: 100, reason: 'owned_cancel_before_network' })).cancelled, true);
        assert.equal((await f.claimAndHandle(cancelled.deliver.id)).result.reason, 'cancelled'); assert.equal(f.attempts.length, cancelledBefore);
        const stopped = await materialize(await create()); await db.AutomationFlowTemplateV2.update({ is_active: false }, { where: { id: 42 } });
        const stoppedBefore = attemptsBefore(), stoppedResult = await f.claimAndHandle(stopped.deliver.id); assert.equal(stoppedResult.executorStatus, 'failed');
        assert.equal(f.attempts.length, stoppedBefore); await db.AutomationFlowTemplateV2.update({ is_active: true }, { where: { id: 42 } });
        context.report.checks.push('Purpose cancellation and actual template-stop guard deny queued dispatch without a provider attempt');

        const changed = await materialize(await create()), changedAppointment = await db.CitaPaciente.findByPk(changed.response.body.id_cita);
        const changedMetadata = structuredClone(changedAppointment.import_metadata); changedMetadata.booking.phases[1].doctor_ids = [1];
        changedMetadata.booking.profile.phases[1].professionals = { ...changedMetadata.booking.profile.phases[1].professionals, ids: [1], preferred_id: 1 };
        await changedAppointment.update({ import_metadata: changedMetadata });
        const changedBefore = attemptsBefore(), changedResult = await f.claimAndHandle(changed.deliver.id); assert.equal(changedResult.executorStatus, 'failed');
        assert.equal(f.attempts.length, changedBefore);
        const visit = await db.AppointmentVisit.findByPk(changed.intent.visit_id);
        await f.foundation.refreshVisitSnapshot({ visitId: visit.id, clinicId: 100, expectedRevision: 1, actorId: 1 });
        const changedPublish = await f.runtime.enqueueExecutionForCita(changedAppointment, { event_name: 'appointment_rescheduled' });
        assert.equal(changedPublish.reason, 'visit_mutation_adapter_required');
        assert.equal(await db.AppointmentVisitCommunication.count({ where: { visit_id: visit.id } }), 1);
        context.report.checks.push('Phase-only doctor mutation is detected from frozen booking projection before dispatch; explicit revision advance preserves old intent and remains closed without mutation-event adapter');

        for (const patch of [{ import_metadata: { synthetic_data_only: true } }, { source_system: 'cliniccloud', source_reference: 'owned_only' },
          { import_metadata: { automation_policy: 'hold' } }]) {
          const guarded = await materialize(await create()), row = await db.CitaPaciente.findByPk(guarded.response.body.id_cita);
          await row.update({ ...patch, ...(patch.import_metadata ? { import_metadata: { ...row.import_metadata, ...patch.import_metadata } } : {}) });
          const guardedBefore = attemptsBefore(), guardedResult = await f.claimAndHandle(guarded.deliver.id);
          assert.equal(guardedResult.executorStatus, 'failed'); assert.equal(f.attempts.length, guardedBefore);
        }
        context.report.checks.push('Real fresh appointment recapture rejects queued lane after QA/synthetic, imported origin or HOLD change; no migration/QA provider attempt');

        const stripped = await materialize(await create());
        const actualFlow = require('../../services/flowEngineV2.service'), legacyBefore = attemptsBefore();
        await assert.rejects(actualFlow.enqueueAutomationWhatsappTransport({ msg: stripped.message, execution: await db.FlowExecutionV2.findByPk(stripped.intent.execution_id), nodeId: 'S' }),
          { code: 'appointment_visit_runtime_legacy_transport_forbidden' });
        const oldScheduled = await actualFlow.runScheduledWhatsappSendJob({ message_id: stripped.message.id });
        assert.equal(oldScheduled.result.reason, 'appointment_visit_runtime_legacy_transport_forbidden'); assert.equal(f.attempts.length, legacyBefore);
        await stripped.message.update({ metadata: { ...stripped.message.metadata, execution_id: null, visit_communication_id: null } });
        assert.equal(await f.broker.isManagedMessage(stripped.message), true, 'durable binding survives metadata stripping');
        await assert.rejects(f.broker.send({ messageId: String(stripped.message.id), clinicId: 100, assetId: 701, expectedBinding: f.binding,
          message: { messaging_product: 'whatsapp', type: 'template', to: stripped.message.metadata.recipient, template: { name: stripped.message.metadata.template_name,
            language: { code: stripped.message.metadata.template_language }, components: stripped.message.metadata.template_components || [] } } }),
          { code: 'whatsapp_authorized_message_ineligible' });
        await assert.rejects(f.managed.assertTransport(stripped.message.id, { schema: 'appointment-visit-transport/1' }),
          { code: 'appointment_visit_runtime_transport_claim_required' });
        context.report.checks.push('Durable Message binding detects stripped managed metadata; direct broker send and client-shaped/JSON transport authorization fail closed');

        const providerStatus = require('../../lib/whatsapp-provider-status');
        const interleaved = await materialize(await create()), originalQuery = f.sql.query.bind(f.sql);
        let interleaving = false;
        const factualSeconds = String(Math.floor(Date.now() / 1000) - 2);
        f.sql.query = async (sql, options) => {
          if (!interleaving && typeof sql === 'string' && sql.includes('JSON_MERGE_PATCH') && sql.includes('UPDATE `Messages`')) {
            interleaving = true;
            await providerStatus.persistProviderStatus({ db, messageId: interleaved.message.id, status: { status: 'delivered', timestamp: String(Number(factualSeconds) + 1) } });
            const lateSent = await providerStatus.persistProviderStatus({ db, messageId: interleaved.message.id, status: { status: 'sent', timestamp: factualSeconds } });
            assert.equal(lateSent.status, 'delivered');
          }
          return originalQuery(sql, options);
        };
        try { assert.equal((await f.claimAndHandle(interleaved.deliver.id)).result.outcome, 'accepted'); }
        finally { f.sql.query = originalQuery; }
        assert.equal(interleaving, true); await interleaved.message.reload();
        assert.equal(interleaved.message.status, 'delivered'); assert.equal(+interleaved.message.sent_at, Number(factualSeconds) * 1000);
        assert.equal(interleaved.message.metadata.wa_status_timestamps.delivered, String(Number(factualSeconds) + 1));
        assert.equal(interleaved.message.metadata.wa_status_timestamps.sent, factualSeconds);
        assert.equal(interleaved.message.metadata.provider_acceptance_status, 'accepted');
        const invalidClock = await db.Message.create({ conversation_id: interleaved.message.conversation_id, direction: 'outbound', status: 'pending' });
        for (const timestamp of ['Infinity', 'NaN', '1e999', '-1', '0', 'nonsense']) {
          await providerStatus.persistProviderStatus({ db, messageId: invalidClock.id, status: { status: 'sent', timestamp } });
          await invalidClock.reload(); assert.equal(invalidClock.sent_at, null);
        }
        context.report.checks.push('Actual extracted webhook status consumer under SQL row lock: delivered-before-sent fills only factual late sent clock without state regression; atomic acceptance interleaving preserves advanced status, clock and both metadata receipts; invalid/nonfinite clocks never persist');

        // Real SQL interleaving in the NETWORK ERROR path, not only success.
        // Insert a factual webhook immediately before the guarded atomic UPDATE
        // which would otherwise record uncertainty from a stale instance.
        for (const advancedStatus of ['sent', 'delivered', 'read']) {
          const advanced = await materialize(await create()); let errorInterleaving = false;
          f.provider('unknown');
          f.sql.query = async (sql, options) => {
            if (!errorInterleaving && typeof sql === 'string' && sql.includes('UPDATE `Messages`') && options?.replacements?.unknown) {
              errorInterleaving = true;
              await providerStatus.persistProviderStatus({ db, messageId: advanced.message.id,
                status: { status: advancedStatus, timestamp: factualSeconds } });
            }
            return originalQuery(sql, options);
          };
          try { assert.equal((await f.claimAndHandle(advanced.deliver.id)).result.outcome, 'accepted'); }
          finally { f.sql.query = originalQuery; f.provider('accept'); }
          assert.equal(errorInterleaving, true); await advanced.message.reload(); await advanced.intent.reload();
          assert.equal(advanced.message.status, advancedStatus); assert.equal(advanced.message.metadata.wa_status.status, advancedStatus);
          assert.equal(advanced.message.metadata.wa_status_history.length, 1); assert.equal(advanced.message.metadata.delivery_unknown, undefined);
          assert.equal(advanced.intent.status, 'accepted');
          if (advancedStatus === 'sent') assert.equal(+advanced.message.sent_at, Number(factualSeconds) * 1000);
          else {
            assert.equal(advanced.message.sent_at, null);
            const lateSent = await providerStatus.persistProviderStatus({ db, messageId: advanced.message.id, status: { status: 'sent', timestamp: factualSeconds } });
            assert.equal(lateSent.status, advancedStatus); assert.equal(+lateSent.sent_at, Number(factualSeconds) * 1000);
          }
          const attempts = attemptsBefore(); await f.jobs.setPending(advanced.deliver.id);
          assert.equal((await f.claimAndHandle(advanced.deliver.id)).result.reason, 'accepted'); assert.equal(f.attempts.length, attempts);
        }
        context.report.checks.push('Network-error catch real SQL interleavings for sent/delivered/read preserve current factual state, status/history metadata and clock; CURRENT reconciliation yields accepted, late sent fills missing advanced clock, and same-job retry makes no second transport; no-receipt unknown remains protected');

        let dispatchedTicks = 0;
        f.scheduler.setExternalDispatcher(async () => { dispatchedTicks++; return 0; });
        const crash = async (patch = {}) => {
          const input = nextBody(patch); f.crashPostcommit(true);
          let response; try { response = await f.post(input); } finally { f.crashPostcommit(false); }
          assert.equal(response.statusCode, 201, JSON.stringify(response.body));
          const intent = await db.AppointmentVisitCommunication.findOne({ where: { owner_appointment_id: response.body.id_cita } });
          assert(intent); assert.equal(intent.execution_id, null); assert.equal(intent.message_id, null);
          return { input, response, intent };
        };
        const recoverable = await crash(), recoveredBefore = await db.FlowExecutionV2.count();
        await Promise.all([f.scheduler._handleCriticalTick(), f.scheduler._handleCriticalTick()]);
        await recoverable.intent.reload(); assert(recoverable.intent.execution_id);
        assert.equal(await db.FlowExecutionV2.count(), recoveredBefore + 1);
        assert.equal(await db.JobRequest.count({ where: { type: 'automations_v2_execute', payload: { execution_id: Number(recoverable.intent.execution_id) } } }), 1);
        const recoveredExecute = await db.JobRequest.findOne({ where: { type: 'automations_v2_execute', payload: { execution_id: Number(recoverable.intent.execution_id) } } });
        const recovered = await materialize({ ...recoverable, execute: recoveredExecute });
        const recoveredAttempts = attemptsBefore(); assert.equal((await f.claimAndHandle(recovered.deliver.id)).result.outcome, 'accepted');
        assert.equal(f.attempts.length, recoveredAttempts + 1, 'tick discovery recovered without repeating the POST');
        await f.scheduler._handleCriticalTick(); assert.equal(await db.FlowExecutionV2.count(), recoveredBefore + 1);
        const dormant = await crash(); f.enable(false);
        let sqlReads = 0;
        f.sql.query = async (...args) => { sqlReads++; return originalQuery(...args); };
        try { await f.scheduler._handleCriticalTick(); } finally { f.sql.query = originalQuery; }
        assert.equal(sqlReads, 0, 'CLOSED real tick discovery performs no SQL'); f.enable(true);
        await dormant.intent.reload(); assert.equal(dormant.intent.execution_id, null);
        const heldRecovery = await crash(), heldRecoveryRow = await db.CitaPaciente.findByPk(heldRecovery.response.body.id_cita);
        await heldRecoveryRow.update({ import_metadata: { ...heldRecoveryRow.import_metadata, automation_policy: 'hold' } });
        const otherNamespace = await crash(), otherVisit = await db.AppointmentVisit.findByPk(otherNamespace.intent.visit_id);
        const otherEnrollment = { ...otherVisit.runtime_enrollment, runtime_namespace: 'other_fixture' };
        await otherVisit.update({ runtime_enrollment: otherEnrollment, runtime_enrollment_sha256: require('../../lib/appointment-visit-communication').hash(otherEnrollment) });
        const noNamespace = await crash(), noNamespaceVisit = await db.AppointmentVisit.findByPk(noNamespace.intent.visit_id);
        const historicalEnrollment = { ...noNamespaceVisit.runtime_enrollment }; delete historicalEnrollment.runtime_namespace;
        await noNamespaceVisit.update({ runtime_enrollment: historicalEnrollment, runtime_enrollment_sha256: require('../../lib/appointment-visit-communication').hash(historicalEnrollment) });
        await f.scheduler._handleCriticalTick();
        for (const item of [heldRecovery, otherNamespace, noNamespace]) { await item.intent.reload(); assert.equal(item.intent.execution_id, null); }
        assert(dispatchedTicks >= 5, 'ordinary critical dispatcher still runs even when discovery closes/holds');
        context.report.checks.push('Real existing scheduler tick discovers committed unbound native birth intent without a repeated POST; concurrent ticks create one execution/job; CLOSED tick has zero SQL; namespace-less/other namespace/HOLD receipts are never adopted and ordinary drain remains reachable');

        // Actual native managed birth/replay with inherited machine policy and
        // alternative equipment; no production catalogue or clinical defaults.
        const treatment = await db.Tratamiento.findByPk(2), equipmentProfile = structuredClone(treatment.clinical_config.booking_profile);
        equipmentProfile.phases[0].equipment_requirements = [{ equipment_ids: [401, 402] }];
        await treatment.update({ clinical_config: { ...treatment.clinical_config, booking_profile: equipmentProfile } });
        const attention = { mode: 'start_end', start_minutes: 5, start_window_minutes: 15, end_minutes: 5, end_window_minutes: 15 };
        await db.BookingEquipment.update({ attention_policy: attention }, { where: { id: 401 } });
        await db.BookingEquipment.create({ id: 402, owner_clinic_id: 100, group_id: 50, name: 'Alternativa owned', family_key: 'owned_fixture_unit',
          mobility: 'mobile', status: 'available', turnaround_minutes: 10, attention_policy: attention });
        await db.BookingEquipmentClinic.create({ equipment_id: 402, clinic_id: 100 });
        await db.BookingEquipmentRoomPolicy.update({ equipment_ids: [401, 402] }, { where: { installation_id: 101 } });
        const machineBody = nextBody(), machineDate = machineBody.inicio.slice(0, 10);
        const machinePreview = async () => {
          const response = await f.physical.http('treatmentSlots', { tratamiento_id: '2', fecha_local: machineDate, duration_minutes: undefined,
            phase_durations: JSON.stringify(machineBody.phase_durations), limit: '200' }); assert.equal(response.statusCode, 200);
          const selected = response.body.slots.find(row => row.start_at === machineBody.inicio); assert(selected); return selected;
        };
        const oldMachine = await machinePreview(); assert.equal(oldMachine.phases[0].equipment[0].id, 401);
        const machineCounts = [await db.CitaPaciente.count(), await db.AppointmentVisitBirthRequest.count(), await db.AppointmentBookingOccupancy.count()];
        await db.BookingEquipment.update({ status: 'unavailable' }, { where: { id: 401 } });
        const alternative = await machinePreview(); assert.equal(alternative.phases[0].equipment[0].id, 402);
        const changedMachine = await f.post({ ...machineBody, booking_plan_sha256: oldMachine.booking_plan_sha256 });
        assert.equal(changedMachine.statusCode, 409); assert.equal(changedMachine.body.code, 'booking_plan_changed'); assert.equal(changedMachine.body.details.can_force, false);
        assert.deepEqual([await db.CitaPaciente.count(), await db.AppointmentVisitBirthRequest.count(), await db.AppointmentBookingOccupancy.count()], machineCounts);
        const refreshedMachineBody = { ...machineBody, booking_plan_sha256: alternative.booking_plan_sha256 }, machineBirth = await f.post(refreshedMachineBody);
        assert.equal(machineBirth.statusCode, 201, JSON.stringify(machineBirth.body)); assert.equal(machineBirth.body.booking_request_replay_supported, true);
        const machineReplay = await f.post(refreshedMachineBody); assert.equal(machineReplay.statusCode, 201, JSON.stringify(machineReplay.body));
        assert.equal(machineReplay.body.id_cita, machineBirth.body.id_cita); assert.equal(machineReplay.body.booking_request_replayed, true);
        const savedMachine = (await db.CitaPaciente.findByPk(machineBirth.body.id_cita)).import_metadata.booking;
        assert.equal(savedMachine.phases[0].equipment[0].id, 402); assert.deepEqual(savedMachine.profile.phases[0].staff_attention, [attention]);
        assert.equal(equipmentProfile.phases[0].staff_attention, undefined, 'effective attention is frozen, never written to source catalogue');
        context.report.checks.push('Actual endpoint/command managed lane: machine401→402 silently changed rejects409 before any birth/occupancy writes; fresh preview402 commits and exact transport replay reproduces inherited machine-attention receipt from real frozen SQL snapshot');

        // More than one page of legitimately held or naturally expired native
        // receipts must not starve later eligible work. No window is modified.
        const invalid = [], futureStart = index => {
          const date = new Date(Date.UTC(2031, 0, 7, 8 + index % 9));
          for (let days = Math.floor(index / 9); days > 0;) {
            date.setUTCDate(date.getUTCDate() + 1); if (![0, 6].includes(date.getUTCDay())) days--;
          }
          return date.toISOString();
        };
        for (let index = 0; index < 14; index++) invalid.push(await crash());
        for (let index = 0; index < 14; index++) {
          const item = await crash({ inicio: futureStart(index) }), row = await db.CitaPaciente.findByPk(item.response.body.id_cita);
          await row.update({ import_metadata: { ...row.import_metadata, automation_policy: 'hold' } }); invalid.push(item);
        }
        const laterEligible = await crash({ inicio: futureStart(14) });
        const unchanged = new Map(invalid.map(item => [item.intent.id, {
          window: [item.intent.window_key, +item.intent.window_starts_at, +item.intent.window_ends_at, item.intent.window_sha256],
          snapshot: item.intent.snapshot_sha256, created: +item.intent.created_at } ]));
        f.clock('2030-02-01T12:00:00.000Z'); f.restartManaged();
        const eligibleBefore = await db.FlowExecutionV2.count(), attemptsAtRecovery = attemptsBefore();
        const firstPage = await Promise.all([f.managed.reconcilePendingBirthIntents({ runtimeNamespace: 'visit_fixture' }),
          f.managed.reconcilePendingBirthIntents({ runtimeNamespace: 'visit_fixture' })]);
        for (const result of firstPage) { assert.equal(result.examined, 25); assert.equal(result.published, 0); }
        await laterEligible.intent.reload(); assert.equal(laterEligible.intent.execution_id, null);
        // Process restart intentionally loses ephemeral progress but not history.
        // Another finite sweep still reaches eligible work after at most two
        // pages of this fixture, even with concurrent ticks.
        f.restartManaged();
        for (let tick = 0; tick < 3; tick++) await Promise.all([f.scheduler._handleCriticalTick(), f.scheduler._handleCriticalTick()]);
        await laterEligible.intent.reload(); assert(laterEligible.intent.execution_id);
        assert.equal(await db.FlowExecutionV2.count(), eligibleBefore + 1);
        assert.equal(await db.JobRequest.count({ where: { type: 'automations_v2_execute', payload: { execution_id: Number(laterEligible.intent.execution_id) } } }), 1);
        for (const item of invalid) {
          await item.intent.reload(); const before = unchanged.get(item.intent.id);
          assert.equal(item.intent.status, 'pending'); assert.equal(item.intent.execution_id, null); assert.equal(item.intent.message_id, null);
          assert.deepEqual([item.intent.window_key, +item.intent.window_starts_at, +item.intent.window_ends_at, item.intent.window_sha256], before.window);
          assert.equal(item.intent.snapshot_sha256, before.snapshot); assert.equal(+item.intent.created_at, before.created);
        }
        assert.equal(f.attempts.length, attemptsAtRecovery, 'fair discovery publishes no provider or Message');
        const released = invalid[14], releasedRow = await db.CitaPaciente.findByPk(released.response.body.id_cita);
        const releasedMetadata = { ...releasedRow.import_metadata }; delete releasedMetadata.automation_policy;
        await releasedRow.update({ import_metadata: releasedMetadata });
        for (let tick = 0; tick < 3; tick++) await f.scheduler._handleCriticalTick();
        await released.intent.reload(); assert(released.intent.execution_id, 'next finite sweep reconsidered previously held receipt without renewing its window');
        assert.deepEqual([released.intent.window_key, +released.intent.window_starts_at, +released.intent.window_ends_at, released.intent.window_sha256], unchanged.get(released.intent.id).window);
        f.enable(false); sqlReads = 0; f.sql.query = async (...args) => { sqlReads++; return originalQuery(...args); };
        try { await Promise.all([f.scheduler._handleCriticalTick(), f.scheduler._handleCriticalTick()]); }
        finally { f.sql.query = originalQuery; f.enable(true); }
        assert.equal(sqlReads, 0); assert.equal(f.attempts.length, attemptsAtRecovery);
        context.report.checks.push('FAIR existing-tick SQL discovery: 14 naturally expired plus14 future HOLD receipts precede later eligible native birth; bounded25 keyset/high-water pages, concurrent ticks and process restart reach exactly one execution/job; next finite sweep rechecks released HOLD at SAME window; all protected receipts/history untouched and CLOSED discovery has zero SQL/provider/Message');

        context.report.fakeProviderAttempts = f.attempts.length;
        context.report.consumerIntegration = 'actual controller/command/runtime/flow/JobRequest handler/common sender/broker; synthetic ACL/ancillary UI summaries and controlled publication/provider only';
      } finally { await f.close(); }
    });
  });
