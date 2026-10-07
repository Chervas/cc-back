'use strict';

// Actual OWNED HTTP -> canonical controller/command -> SQL mutation receipt ->
// flow Message/job -> private common sender/broker. Synthetic ACL/ancillary UI,
// local queue publication and fake transport are declared fixture boundaries.
const test = require('node:test'), assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitMutationFixture } = require('./helpers/owned-visit-mutation-fixture');
const v = require('../../lib/appointment-visit-communication');
const r = require('../../lib/appointment-visit-runtime-contract');

test('managed visit movements/cancellation: durable native command revisions and purpose-native communication',
  { skip: process.env.APPOINTMENT_VISIT_MUTATIONS_MYSQL_TEST !== '1', timeout: 180000 }, async () => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createOwnedVisitMutationFixture(context), { db } = f;
      try {
        let serial = 0;
        const create = async () => {
          const day = 7 + serial++ * 7, start = new Date(Date.UTC(2030, 0, day, 9)).toISOString();
          const input = f.body({ inicio: start }), response = await f.post(input);
          assert.equal(response.statusCode, 201, JSON.stringify(response.body));
          const row = await db.CitaPaciente.findByPk(response.body.id_cita);
          const intent = await db.AppointmentVisitCommunication.findOne({ where: { owner_appointment_id: row.id_cita } }); assert(intent);
          const visit = await db.AppointmentVisit.findByPk(intent.visit_id);
          assert.deepEqual(visit.runtime_enrollment.manifests.map(item => item.trigger_type), ['appointment_created','appointment_rescheduled','appointment_cancelled']);
          return { input, row, intent, visit };
        };
        const materialize = async item => {
          await item.intent.reload();
          const execution = await db.JobRequest.findOne({ where: { type: 'automations_v2_execute', payload: { execution_id: Number(item.intent.execution_id) } } });
          assert(execution);
          const handled = await f.claimAndHandle(execution.id); assert.equal(handled.status, 'waiting', JSON.stringify(handled));
          await item.intent.reload(); item.message = await db.Message.findByPk(item.intent.message_id); assert(item.message);
          item.deliver = await db.JobRequest.findOne({ where: { type: 'appointment_visit_dispatch', payload: { visit_communication_id: item.intent.id } } });
          assert(item.deliver); return item;
        };
        const newStage = async item => {
          await item.visit.reload(); await item.row.reload();
          const intent = await db.AppointmentVisitCommunication.findOne({ where: { visit_id: item.visit.id, communication_revision: item.visit.communication_revision } });
          assert(intent, 'a reviewed event graph creates one new durable purpose');
          return { ...item, intent, message: null, deliver: null };
        };
        const movement = (item, patch = {}) => {
          const from = new Date(new Date(item.input.inicio).getTime() + 86400000), to = new Date(from.getTime() + 40 * 60000);
          return { inicio: from.toISOString(), fin: to.toISOString(), reschedule_reason: 'clinic_schedule',
            booking_selection: item.input.booking_selection, ...patch };
        };
        const mutationRows = item => db.PatientOperationalEvent.findAll({ where: { event_type: r.MUTATION_EVENT,
          metadata: { mutation: { visit_id: item.visit.id } } }, order: [['id','ASC']] });
        const fingerprint = async item => JSON.stringify({ row: (await db.CitaPaciente.findByPk(item.row.id_cita)).toJSON(),
          visit: (await db.AppointmentVisit.findByPk(item.visit.id)).toJSON(),
          intents: (await db.AppointmentVisitCommunication.findAll({ where: { visit_id: item.visit.id }, order: [['id','ASC']] })).map(row => row.toJSON()),
          occupancies: (await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: item.row.id_cita }, order: [['id','ASC']] })).map(row => row.toJSON()) });

        const moving = await materialize(await create()), before = structuredClone(moving.visit.snapshot), enrollment = moving.visit.runtime_enrollment_sha256;
        const moveBody = movement(moving), moved = await f.patch(moving.row.id_cita, 'move', moveBody);
        assert.equal(moved.statusCode, 200, JSON.stringify(moved.body));
        await moving.row.reload(); await moving.visit.reload(); await moving.intent.reload();
        assert.equal(moving.row.id_cita, moving.visit.owner_appointment_id); assert.equal(moving.visit.communication_revision, 2);
        assert.equal(moving.visit.runtime_enrollment_sha256, enrollment); assert.equal(moving.intent.status, 'cancelled');
        assert.deepEqual(moving.intent.snapshot, before); assert.equal(moving.row.inicio.toISOString(), moveBody.inicio);
        const events = await mutationRows(moving); assert.equal(events.length, 1);
        assert.deepEqual(events[0].metadata.mutation.before_snapshot, before);
        assert.deepEqual(events[0].metadata.mutation.snapshot, moving.visit.snapshot);
        const next = await newStage(moving);
        assert.equal(next.intent.purpose, 'appointment_details'); assert.equal(next.intent.template_version_id, 43);
        assert.equal(next.intent.runtime_stage.mutation_event_id, String(events[0].id));
        assert.equal(next.intent.window_starts_at.toISOString(), events[0].metadata.mutation.recorded_at);
        const tries = f.attempts.length, stale = await f.claimAndHandle(moving.deliver.id);
        assert.equal(stale.executorStatus, 'failed', JSON.stringify(stale)); assert.equal(f.attempts.length, tries);
        const replay = await f.patch(moving.row.id_cita, 'move', moveBody); assert.equal(replay.statusCode, 200, JSON.stringify(replay.body));
        assert.equal((await mutationRows(moving)).length, 1); assert.equal(await db.AppointmentVisitCommunication.count({ where: { visit_id: moving.visit.id } }), 2);
        const currentExecution = await db.FlowExecutionV2.findByPk(next.intent.execution_id);
        assert.equal(currentExecution.status, 'running', 'same target replay must not cancel the NEW purpose execution');
        await materialize(next); const sent = await f.claimAndHandle(next.deliver.id);
        assert.equal(sent.result.outcome, 'accepted', JSON.stringify(sent)); assert.equal(f.attempts.length, tries + 1);
        await f.jobs.setPending(next.deliver.id); assert.equal((await f.claimAndHandle(next.deliver.id)).result.reason, 'accepted');
        assert.equal(f.attempts.length, tries + 1);
        context.report.checks.push('Actual HTTP movement uses command/solver/resource occupancy + same appointment/visit identity, immutable old snapshot and native append-only before/after receipt; pending old dispatch cannot send; exact PATCH replay preserves one revision/intent/current execution; new reschedule purpose reaches actual broker once');

        const silent = await materialize(await create());
        const silentMove = await f.patch(silent.row.id_cita, 'move', movement(silent, { reschedule_reason: 'administrative_error' }));
        assert.equal(silentMove.statusCode, 200, JSON.stringify(silentMove.body)); await silent.intent.reload(); await silent.visit.reload();
        assert.equal(silent.intent.status, 'cancelled'); assert.equal(silent.visit.communication_revision, 2);
        assert.equal((await mutationRows(silent))[0].metadata.mutation.suppressed, true);
        assert.equal(await db.AppointmentVisitCommunication.count({ where: { visit_id: silent.visit.id } }), 1);
        const silentBefore = f.attempts.length; await f.claimAndHandle(silent.deliver.id); assert.equal(f.attempts.length, silentBefore);
        context.report.checks.push('Administrative-error move still updates the real booking/revision and revokes old pending delivery but creates no new communication/provider attempt');

        const cancelled = await materialize(await create()), cancellationBefore = f.attempts.length;
        const cancellation = await f.patch(cancelled.row.id_cita, 'state', { estado: 'cancelada' });
        assert.equal(cancellation.statusCode, 200, JSON.stringify(cancellation.body)); await cancelled.row.reload(); await cancelled.visit.reload(); await cancelled.intent.reload();
        assert.equal(cancelled.row.estado, 'cancelada'); assert.equal(cancelled.visit.communication_revision, 2); assert.equal(cancelled.intent.status, 'cancelled');
        const cancelStage = await newStage(cancelled); assert.equal(cancelStage.intent.purpose, 'cancellation'); assert.equal(cancelStage.intent.template_version_id, 44);
        assert.equal(cancelStage.intent.window_key, 'cancellation'); assert.equal(cancelStage.intent.window_ends_at - cancelStage.intent.window_starts_at, 3600000);
        await f.claimAndHandle(cancelled.deliver.id); assert.equal(f.attempts.length, cancellationBefore);
        const cancelReplay = await f.patch(cancelled.row.id_cita, 'state', { estado: 'cancelada' }); assert.equal(cancelReplay.statusCode, 200, JSON.stringify(cancelReplay.body));
        assert.equal((await mutationRows(cancelled)).length, 1);
        await materialize(cancelStage); const cancelSent = await f.claimAndHandle(cancelStage.deliver.id);
        assert.equal(cancelSent.result.outcome, 'accepted', JSON.stringify(cancelSent)); assert.equal(f.attempts.length, cancellationBefore + 1);
        assert.equal((await db.CitaPaciente.findByPk(cancelled.row.id_cita)).estado, 'cancelada');
        context.report.checks.push('Actual cancellation endpoint/command releases capacity by canonical state and keeps old reservation provenance; native cancelled lifecycle has its own reviewed cancellation event/grace/purpose, exact repeat stays one and final common sender/broker sends cancellation once, never old details');

        const preserved = await fingerprint(cancelled), preservedJobs = JSON.stringify((await db.JobRequest.findAll({ order: [['id','ASC']] })).map(row => row.toJSON()));
        const preservedExecutions = JSON.stringify((await db.FlowExecutionV2.findAll({ order: [['id','ASC']] })).map(row => row.toJSON()));
        const preservedEvents = JSON.stringify((await db.PatientOperationalEvent.findAll({ order: [['id','ASC']] })).map(row => row.toJSON()));
        const deleteTrace = [];
        db.sequelize.addHook('afterQuery', 'owned_managed_delete_guard', (_options, query) => { if (query.sql) deleteTrace.push(query.sql); });
        try { const denied = await f.delete(cancelled.row.id_cita); assert.equal(denied.statusCode, 409, JSON.stringify(denied.body)); assert.equal(denied.body.code, 'appointment_visit_history_preserved'); }
        finally { db.sequelize.removeHook('afterQuery', 'owned_managed_delete_guard'); }
        assert.equal(await fingerprint(cancelled), preserved);
        assert.equal(JSON.stringify((await db.JobRequest.findAll({ order: [['id','ASC']] })).map(row => row.toJSON())), preservedJobs);
        assert.equal(JSON.stringify((await db.FlowExecutionV2.findAll({ order: [['id','ASC']] })).map(row => row.toJSON())), preservedExecutions);
        assert.equal(JSON.stringify((await db.PatientOperationalEvent.findAll({ order: [['id','ASC']] })).map(row => row.toJSON())), preservedEvents);
        assert(!deleteTrace.some(query => /^\s*(UPDATE|DELETE|INSERT)\b/i.test(query)), 'early history guard performs no destructive SQL');
        context.report.checks.push('Actual DELETE endpoint returns explicit history-preserved409 before any SQL write or workflow cleanup; Cita/occupancy/visit/intents/native jobs/executions/append-only events remain byte-equivalent. This fixture has no signed consent rows and makes no separate signature-preservation claim.');

        for (const outcome of ['accepted', 'unknown']) {
          const item = await materialize(await create()); f.provider(outcome === 'unknown' ? 'unknown' : 'accept');
          const delivery = await f.claimAndHandle(item.deliver.id); assert.equal(delivery.result.outcome, outcome); f.provider('accept');
          await item.intent.reload(); const oldReceipt = item.intent.toJSON();
          const result = await f.patch(item.row.id_cita, 'state', { estado: 'cancelada' }); assert.equal(result.statusCode, 200, JSON.stringify(result.body));
          await item.intent.reload(); assert.equal(item.intent.status, outcome); assert.equal(item.intent.message_id, oldReceipt.message_id);
          assert.deepEqual(item.intent.snapshot, oldReceipt.snapshot);
          const count = f.attempts.length; await f.jobs.setPending(item.deliver.id); await f.claimAndHandle(item.deliver.id); assert.equal(f.attempts.length, count);
        }
        context.report.checks.push('Cancel after accepted and after network-unknown preserves original exact Message/receipt/snapshot and cannot grant a second transport for the old purpose');

        const rolled = await materialize(await create()), preRollback = await fingerprint(rolled), rollbackCount = await db.PatientOperationalEvent.count();
        db.PatientOperationalEvent.addHook('beforeCreate', 'owned_mutation_failure', row => { if (row.event_type === r.MUTATION_EVENT) throw Error('OWNED_MUTATION_EVENT_FAILURE'); });
        try { const failed = await f.patch(rolled.row.id_cita, 'move', movement(rolled)); assert.equal(failed.statusCode, 500); }
        finally { db.PatientOperationalEvent.removeHook('beforeCreate', 'owned_mutation_failure'); }
        assert.equal(await fingerprint(rolled), preRollback); assert.equal(await db.PatientOperationalEvent.count(), rollbackCount);
        assert.equal((await db.Message.findByPk(rolled.message.id)).metadata.cancelled, undefined);
        context.report.checks.push('Injected real append-only event failure rolls back appointment/visit/CAS revision, occupancy, old intent and bound Message cancellation together; no half-move or communication survives');

        const racing = await create(), sameTarget = movement(racing);
        const results = await Promise.all(Array.from({ length: 4 }, () => f.patch(racing.row.id_cita, 'move', sameTarget)));
        for (const result of results) assert.equal(result.statusCode, 200, JSON.stringify(result.body));
        await racing.visit.reload(); assert.equal(racing.visit.communication_revision, 2); assert.equal((await mutationRows(racing)).length, 1);
        assert.equal(await db.AppointmentVisitCommunication.count({ where: { visit_id: racing.visit.id } }), 2);
        const raceStage = await materialize(await newStage(racing)), raceBefore = f.attempts.length;
        assert.equal((await f.claimAndHandle(raceStage.deliver.id)).result.outcome, 'accepted'); assert.equal(f.attempts.length, raceBefore + 1);
        context.report.checks.push('Four native concurrent same-target PATCHes serialize on the canonical booking row: exactly one revision/append-only event/new intent, one current purpose execution and one broker transport');

        const racingDelivery = await materialize(await create()), deliveryBefore = f.attempts.length;
        let enter, release;
        const entered = new Promise(resolve => { enter = resolve; }), barrier = new Promise(resolve => { release = resolve; });
        db.CitaPaciente.addHook('beforeUpdate', 'owned_move_holds_canonical_row', async row => {
          if (row.id_cita === racingDelivery.row.id_cita && row.changed('inicio')) { enter(); await barrier; }
        });
        let movePromise, dispatchPromise;
        try {
          movePromise = f.patch(racingDelivery.row.id_cita, 'move', movement(racingDelivery)); await entered;
          let settled = false;
          dispatchPromise = f.claimAndHandle(racingDelivery.deliver.id).finally(() => { settled = true; });
          await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(settled, false, 'native dispatch waits for canonical Cita lock');
          release(); const move = await movePromise, dispatch = await dispatchPromise;
          assert.equal(move.statusCode, 200, JSON.stringify(move.body)); assert.equal(dispatch.executorStatus, 'failed', JSON.stringify(dispatch));
          assert.equal(f.attempts.length, deliveryBefore); await racingDelivery.intent.reload(); assert.equal(racingDelivery.intent.status, 'cancelled');
        } finally {
          release(); db.CitaPaciente.removeHook('beforeUpdate', 'owned_move_holds_canonical_row');
          if (movePromise) await movePromise; if (dispatchPromise) await dispatchPromise;
        }
        context.report.checks.push('Actual queued job races an in-flight HTTP movement: final dispatcher demonstrably blocks on native canonical row, then fails the committed old-revision guard with no provider attempt/deadlock or stale schedule send');

        const semantic = await create(), semanticHash = semantic.visit.snapshot_sha256;
        const confirmation = await f.patch(semantic.row.id_cita, 'state', { estado: 'info_confirmada' }); assert.equal(confirmation.statusCode, 200, JSON.stringify(confirmation.body));
        await f.physical.reserve({ existingAppointmentId: semantic.row.id_cita,
          appointmentValues: { nota: 'Nota interna ficticia conservada', titulo: 'Título interno ficticio', updated_by: 1 },
          selections: semantic.input.booking_selection, allowObsolete: true });
        await semantic.row.reload(); await semantic.visit.reload();
        assert.equal(semantic.row.nota, 'Nota interna ficticia conservada'); assert.equal(semantic.row.titulo, 'Título interno ficticio');
        assert.equal(semantic.row.estado, 'info_confirmada'); assert.equal(semantic.visit.communication_revision, 1);
        assert.equal(semantic.visit.snapshot_sha256, semanticHash); assert.equal((await mutationRows(semantic)).length, 0);
        assert.equal(await db.AppointmentVisitCommunication.count({ where: { visit_id: semantic.visit.id } }), 1);
        context.report.checks.push('Real status endpoint plus canonical note/title edit do not advance communication geometry/lifecycle: notes and active confirmation stay outside revision hashing, preserving exact appointment fields without a spurious new purpose; no nonexistent appointment price column or billing effect is asserted');

        const recovery = await materialize(await create()); f.crashPostcommit(true);
        try { const persisted = await f.patch(recovery.row.id_cita, 'move', movement(recovery), 2); assert.equal(persisted.statusCode, 200, JSON.stringify(persisted.body)); }
        finally { f.crashPostcommit(false); }
        const stranded = await newStage(recovery); assert.equal(stranded.intent.execution_id, null); assert.equal(stranded.intent.message_id, null);
        f.restartManaged(); const recovered = await f.managed.reconcilePendingBirthIntents({ runtimeNamespace: 'visit_fixture', limit: 25 });
        assert.equal(recovered.published, 1, JSON.stringify(recovered)); await stranded.intent.reload(); assert(stranded.intent.execution_id);
        const executionId = stranded.intent.execution_id;
        assert.equal(stranded.intent.created_by, 2);
        assert.equal((await db.FlowExecutionV2.findByPk(executionId)).created_by, 2, 'native mutation actor survives discovery, rather than birth/template actor');
        assert.equal((await mutationRows(recovery))[0].actor_user_id, 2);
        assert.equal((await f.managed.reconcilePendingBirthIntents({ runtimeNamespace: 'visit_fixture', limit: 25 })).published, 0);
        assert.equal((await db.AppointmentVisitCommunication.findByPk(stranded.intent.id)).execution_id, executionId);
        await materialize(stranded); const recoveredBefore = f.attempts.length;
        assert.equal((await f.claimAndHandle(stranded.deliver.id)).result.outcome, 'accepted'); assert.equal(f.attempts.length, recoveredBefore + 1);
        context.report.checks.push('Simulated postcommit publication crash leaves actual movement/append-only receipt/new intent durable; restarted native discovery recovers that revision/event graph once into execution/job/Message and actual broker transport, without renewing its event window or replacing native mutation actor2 with birth/template actor1');

        const corrupt = await create(), validMove = await f.patch(corrupt.row.id_cita, 'move', movement(corrupt)); assert.equal(validMove.statusCode, 200);
        const corruptStage = await materialize(await newStage(corrupt)), corruptEvents = await mutationRows(corrupt);
        const originalMetadata = corruptEvents[0].metadata;
        const altered = structuredClone(originalMetadata); altered.mutation.actor_id = 2; altered.mutation_sha256 = v.hash(altered.mutation);
        await db.sequelize.query('UPDATE PatientOperationalEvents SET metadata=CAST(:metadata AS JSON) WHERE id=:id', { replacements: { metadata: JSON.stringify(altered), id: corruptEvents[0].id } });
        const corruptBefore = f.attempts.length, denial = await f.claimAndHandle(corruptStage.deliver.id);
        assert.equal(denial.executorStatus, 'failed', JSON.stringify(denial)); assert.equal(f.attempts.length, corruptBefore);
        await db.sequelize.query('UPDATE PatientOperationalEvents SET metadata=CAST(:metadata AS JSON) WHERE id=:id', { replacements: { metadata: JSON.stringify(originalMetadata), id: corruptEvents[0].id } });
        context.report.checks.push('Fresh final pre-network authorization reads the native mutation receipt: even rehashed forged actor metadata cannot replace its SQL actor or grant a provider attempt');

        const closed = await materialize(await create()); f.enable(false);
        const closedMove = await f.patch(closed.row.id_cita, 'move', movement(closed)); assert.equal(closedMove.statusCode, 200, JSON.stringify(closedMove.body));
        await closed.intent.reload(); await closed.visit.reload(); assert.equal(closed.intent.status, 'cancelled'); assert.equal(closed.visit.communication_revision, 2);
        assert.equal(await db.AppointmentVisitCommunication.count({ where: { visit_id: closed.visit.id } }), 1);
        f.enable(true); f.restartManaged(); const closedPublish = await f.runtime.enqueueExecutionForCita(await db.CitaPaciente.findByPk(closed.row.id_cita), { event_name: 'appointment_rescheduled' });
        assert.equal(closedPublish.skipped, true); assert.equal(await db.AppointmentVisitCommunication.count({ where: { visit_id: closed.visit.id } }), 1);
        const stopped = await create(); f.registry([f.manifests()[0]]);
        const missing = await f.patch(stopped.row.id_cita, 'move', movement(stopped)); assert.equal(missing.statusCode, 200, JSON.stringify(missing.body));
        await stopped.visit.reload(); assert.equal(stopped.visit.communication_revision, 2);
        assert.equal(await db.AppointmentVisitCommunication.count({ where: { visit_id: stopped.visit.id } }), 1);
        context.report.checks.push('Closed rollout and removed reviewed event registry do not block valid movement: revision/old-right cancellation stays durable, but no new intent/legacy fallback/backlog right is invented on reopening/restart');

        // A reviewed OWNED graph has an actual C node after S. Booking rollout
        // remains CLOSED: this exercises FlowEngine's legacy writer adapter,
        // not a mocked change-status function or a fixture-only decision gate.
        await f.configureAutomaticCancellation();
        assert.equal(require('../../services/treatmentBookingProfile.service').bookingCapabilities().simple, false);
        f.scheduler.setExternalDispatcher(async () => 0);
        const resumeSentStage = async (item, afterAdvance = null) => {
          const executionJob = await db.JobRequest.findOne({ where: { type: 'automations_v2_execute', payload: { execution_id: Number(item.intent.execution_id) } } });
          const executionId = Number(item.intent.execution_id);
          if (afterAdvance) db.FlowExecutionV2.addHook('afterUpdate', 'owned_after_actual_C_advance', async (execution, options) => {
            if (Number(execution.id) === executionId && execution.changed('current_node_id') && execution.current_node_id === 'C') {
              assert(options.transaction, 'actual native C advance is transactional');
              options.transaction.afterCommit(() => afterAdvance(executionId));
            }
          });
          try {
            assert.equal((await f.claimAndHandle(item.deliver.id)).result.outcome, 'accepted');
            await item.message.update({ status: 'sent', sent_at: new Date() }); // OWNED factual receipt; no real webhook claim.
            await executionJob.update({ next_run_at: new Date(Date.now() - 1000) });
            return await f.claimAndHandle(executionJob.id);
          } finally { if (afterAdvance) db.FlowExecutionV2.removeHook('afterUpdate', 'owned_after_actual_C_advance'); }
        };
        const automatic = await materialize(await create()), automaticBefore = f.attempts.length;
        const completedMutation = await resumeSentStage(automatic);
        assert.equal(completedMutation.executorStatus, 'completed', JSON.stringify(completedMutation));
        await automatic.row.reload(); await automatic.visit.reload(); await automatic.intent.reload();
        assert.equal(automatic.row.estado, 'cancelada'); assert.equal(automatic.visit.communication_revision, 2);
        assert.equal(automatic.intent.status, 'accepted'); assert.equal((await mutationRows(automatic)).length, 1);
        const automaticCancellation = await newStage(automatic), frozenWindow = +automaticCancellation.intent.window_ends_at;
        await f.scheduler._handleCriticalTick(); await f.scheduler._handleCriticalTick();
        await automaticCancellation.intent.reload(); assert(automaticCancellation.intent.execution_id);
        assert.equal(+automaticCancellation.intent.window_ends_at, frozenWindow);
        await materialize(automaticCancellation);
        assert.equal((await f.claimAndHandle(automaticCancellation.deliver.id)).result.outcome, 'accepted');
        assert.equal(f.attempts.length, automaticBefore + 2);
        context.report.checks.push('Actual reviewed graph S→C→E under booking.simple=false waits for factual native sent receipt, then canonical legacy state writer persists cancellation revision/event/new purpose with same actor; existing critical scheduler discovers cancellation once and final broker sends that purpose once without renewing window or duplicating old accepted details');

        // Postcommit hooks alter only OWNED native state after the real worker
        // has advanced to C. The following worker still runs its real claimed
        // JobRequest/FlowEngine/transaction guard; no authority predicate is replaced.
        const template42 = await db.AutomationFlowTemplateV2.findByPk(42), reviewedNodes = structuredClone(template42.nodes);
        const mutable = await materialize(await create()), mutableSnapshot = mutable.visit.snapshot_sha256;
        let changedGraph = false;
        const mutableResult = await resumeSentStage(mutable, async () => {
          const nodes = structuredClone(reviewedNodes); nodes.find(node => node.id === 'C').config.new_status = 'cambio_solicitado';
          await template42.update({ nodes }); changedGraph = true;
        });
        try {
          assert(changedGraph); assert.equal(mutableResult.executorStatus, 'failed', JSON.stringify(mutableResult));
          assert.match(mutableResult.error?.code || mutableResult.error?.message || String(mutableResult.error), /^appointment_visit_runtime_(graph_changed|mutation_node_unapproved)$/, JSON.stringify(mutableResult));
          await mutable.row.reload(); await mutable.visit.reload(); assert.equal(mutable.row.estado, 'pendiente');
          assert.equal(mutable.visit.communication_revision, 1); assert.equal(mutable.visit.snapshot_sha256, mutableSnapshot);
          assert.equal((await mutationRows(mutable)).length, 0);
        } finally { await template42.update({ nodes: reviewedNodes }); }
        context.report.checks.push('Actual native worker advances to C before published graph is altered; current managed mutation authority rejects mutable graph before Cita write/event/revision, even though the already-running node was permitted in its original manifest');

        const staleMutation = await materialize(await create());
        const staleMutationResult = await resumeSentStage(staleMutation, async () => {
          const body = movement(staleMutation);
          await f.physical.reserve({ existingAppointmentId: staleMutation.row.id_cita,
            appointmentValues: { inicio: body.inicio, fin: body.fin, reschedule_reason: body.reschedule_reason, updated_by: 2 },
            selections: body.booking_selection, allowObsolete: true });
        });
        assert.equal(staleMutationResult.executorStatus, 'failed', JSON.stringify(staleMutationResult));
        assert.equal(staleMutationResult.error?.code || staleMutationResult.error?.message || staleMutationResult.error, 'appointment_visit_revision_changed', JSON.stringify(staleMutationResult));
        await staleMutation.row.reload(); await staleMutation.visit.reload();
        assert.equal(staleMutation.row.estado, 'pendiente'); assert.equal(staleMutation.visit.communication_revision, 2);
        assert.equal((await mutationRows(staleMutation)).length, 1, 'only real concurrent movement, no stale cancellation');
        assert.equal(await db.AppointmentVisitCommunication.count({ where: { visit_id: staleMutation.visit.id, purpose: 'cancellation' } }), 0);
        context.report.checks.push('Actual canonical movement commits after worker reaches C and before its mutation; old native execution revision cannot cancel the newly moved visit or create a cancellation intent, despite still holding its real claimed job');

        const unbound = await materialize(await create());
        const unboundResult = await resumeSentStage(unbound, async executionId => {
          const execution = await db.FlowExecutionV2.findByPk(executionId), context = structuredClone(execution.context);
          delete context.appointment_visit; await execution.update({ context });
        });
        assert.equal(unboundResult.executorStatus, 'failed', JSON.stringify(unboundResult));
        assert.equal(unboundResult.error?.code || unboundResult.error?.message || unboundResult.error, 'appointment_visit_runtime_mutation_binding_required', JSON.stringify(unboundResult));
        await unbound.row.reload(); await unbound.visit.reload();
        assert.equal(unbound.row.estado, 'pendiente'); assert.equal(unbound.visit.communication_revision, 1);
        assert.equal((await mutationRows(unbound)).length, 0);
        context.report.checks.push('Native execution loses visit binding only after real advance to C: enrolled target cannot fall through legacy state writer; no write/revision/purpose is granted from caller context or positive actor alone');

        context.report.fakeProviderAttempts = f.attempts.length;
        context.report.boundary = 'Native OWNED HTTP controller/command/resource SQL and actual flow/job/common sender/private broker; synthetic ACL/ancillary UI/queue; fake provider only. No real rollout, graph, patient, role session, migration or reminder/ACK/timeout consumers claimed.';
      } finally { await f.close(); }
    });
  });
