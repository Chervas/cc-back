'use strict';

// Real HTTP handlers/domain SQL/solver/canonical writer/visit/job/flow/broker.
// Explicit synthetic session ACL; private MySQL --skip-networking and fake
// broker transport. Does not assert app authentication or real delivery.
const test = require('node:test'), assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVoucherVisitFixture } = require('./helpers/owned-voucher-visit-fixture');
const { createVoucherBookingOriginReader, proofOrigin } = require('../../lib/voucher-booking-origin');
const replay = require('../../lib/voucher-booking-replay');

test('new native future voucher bookings reuse managed birth/intents atomically and recover without parent reenqueues',
  { skip: process.env.VOUCHER_VISIT_ORIGIN_MYSQL_TEST !== '1', timeout: 180000 }, async () => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createOwnedVoucherVisitFixture(context), { db } = f;
      try {
        const prepare = async (voucher, body) => {
          const response = await f.request(voucher, 'appointment-plan', body);
          assert.equal(response.status, 200, JSON.stringify(response)); assert.equal(response.body.has_conflicts, false, JSON.stringify(response));
          return { body, proposal: response.body, payload: f.seal(body, response.body) };
        };
        const commit = async (voucher, planned) => {
          const result = await f.request(voucher, 'appointments', planned.payload);
          assert.equal(result.status, 201, JSON.stringify(result)); return result;
        };
        const visitFor = async id => {
          const member = await db.AppointmentVisitMember.findByPk(id); assert(member);
          return db.AppointmentVisit.findByPk(member.visit_id);
        };
        const materialize = async id => {
          const intent = await db.AppointmentVisitCommunication.findOne({ where: { owner_appointment_id: id, communication_revision: 1 } }); assert(intent);
          const job = await db.JobRequest.findOne({ where: { type: 'automations_v2_execute', payload: { execution_id: Number(intent.execution_id) } } }); assert(job);
          const result = await f.claimAndHandle(job.id); assert.equal(result.status, 'waiting', JSON.stringify(result));
          await intent.reload(); const message = await db.Message.findByPk(intent.message_id); assert(message); assert.equal(message.sent_at, null);
          const deliver = await db.JobRequest.findOne({ where: { type: 'appointment_visit_dispatch', payload: { visit_communication_id: intent.id } } }); assert(deliver);
          return { intent, job, message, deliver };
        };
        const ordinaryBefore = await db.PatientVoucherMovement.count();
        const voucher = await f.voucher({ source_system: 'cliniccloud', patient_id: 1 });
        const originalPurchase = (await voucher.reload()).toJSON(), planned = await prepare(voucher, f.payload());
        const race = await Promise.all([f.request(voucher, 'appointments', planned.payload), f.request(voucher, 'appointments', planned.payload)]);
        assert.deepEqual(race.map(row => row.status).sort(), [200, 201], JSON.stringify(race));
        const created = race.find(row => row.status === 201), id = created.body.created[0].id;
        assert.equal(await db.CitaPaciente.count(), 1); assert.equal(await db.AppointmentVisit.count(), 1);
        assert.equal(await db.AppointmentVisitCommunication.count(), 1); assert.equal(await db.AppointmentVisitBirthRequest.count(), 1);
        assert.equal(await db.FlowExecutionV2.count(), 1); assert.equal(await db.JobRequest.count(), 1);
        const visit = await visitFor(id), appointment = await db.CitaPaciente.findByPk(id);
        assert.equal(visit.runtime_enrollment.origin.schema, 'appointment-visit-voucher-origin/1');
        assert.equal(visit.runtime_enrollment.origin.purchase_references.source_system, 'cliniccloud');
        assert.equal(appointment.source_system, null); assert.equal(appointment.import_metadata.booking.profile.phases.length, 1);
        assert.equal(appointment.voucher_id, voucher.id); assert.equal(visit.runtime_enrollment.origin.sequence, 1);
        assert.notEqual(visit.runtime_enrollment.birth_request_key, planned.proposal.booking_request_key);
        assert.deepEqual((await voucher.reload()).toJSON(), originalPurchase);
        assert.equal(await db.PatientVoucherMovement.count(), ordinaryBefore);
        const item = await materialize(id), sent = await f.claimAndHandle(item.deliver.id);
        assert.equal(sent.result.outcome, 'accepted', JSON.stringify(sent)); assert.equal(f.attempts.length, 1);
        await f.jobs.setPending(item.deliver.id); assert.equal((await f.claimAndHandle(item.deliver.id)).result.reason, 'accepted');
        assert.equal(f.attempts.length, 1); assert.equal((await db.Message.findByPk(item.message.id)).sent_at, null);
        context.report.checks.push('Imported original purchase is NOT adopted as an appointment: NEW source-free canonical single-step v4 booking freezes references, actor/slot/parent receipt; concurrent POST201+200 gives one Cita/visit/intent/job and one real flow/fake-broker attempt; balance/consumption unchanged');

        const currentCounts = await f.counts(), hooks = f.state.hooks.length;
        const actorSteal = await f.request(voucher, 'appointments', planned.payload, { actor: 2 });
        assert.equal(actorSteal.status, 403); assert.equal(actorSteal.body.code, 'voucher_booking_request_forbidden');
        const calls = f.state.serviceCalls.length; assert.equal((await f.request(voucher, 'appointments', planned.payload, { actor: 3 })).status, 403);
        assert.equal(f.state.serviceCalls.length, calls); assert.deepEqual(await f.counts(), currentCounts); assert.equal(f.state.hooks.length, hooks);
        await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
          const reader = createVoucherBookingOriginReader({ db });
          const proof = await reader.forVisit({ visit, appointment, transaction });
          assert.equal(proofOrigin(proof, { transaction, db }).voucher_id, Number(voucher.id));
          assert.throws(() => proofOrigin(JSON.parse(JSON.stringify(proof)), { transaction, db }), /server_origin_required/);
          const foreignReader = createVoucherBookingOriginReader({ db });
          assert.throws(() => foreignReader.ownProof(proof, transaction), /server_origin_required/);
        });
        context.report.checks.push('Actual ACL-before-service and actor-bound parent receipt prevent stealing; native origin proof cannot survive JSON cloning or another reader factory');

        // Simulates commit surviving process failure before first enqueue, then
        // destroys the real HTTP response. Parent retry NEVER runs those hooks.
        const lostVoucher = await f.voucher({ patient_id: 2, source_system: 'clinicaclick' });
        const lost = await prepare(lostVoucher, f.payload({ start_at: '2030-01-08T09:00:00Z' }));
        f.state.crashBeforeEnqueue = true;
        await assert.rejects(f.request(lostVoucher, 'appointments', lost.payload, { drop: true }), { code: 'ECONNRESET' });
        f.state.crashBeforeEnqueue = false;
        const pending = await db.AppointmentVisitCommunication.findOne({ where: { patient_id: 2 } }); assert(pending); assert.equal(pending.execution_id, null);
        const beforeRetry = await f.counts(), beforeHooks = f.state.hooks.length;
        const recovered = await f.request(lostVoucher, 'appointments', lost.payload); assert.equal(recovered.status, 200); assert.equal(recovered.body.replayed, true);
        assert.deepEqual(await f.counts(), beforeRetry); assert.equal(f.state.hooks.length, beforeHooks);
        f.restartManaged();
        await Promise.all(Array.from({ length: 4 }, () => f.managed.reconcilePendingBirthIntents({ runtimeNamespace: 'visit_fixture', limit: 100 })));
        await pending.reload(); assert(pending.execution_id);
        assert.equal(await db.FlowExecutionV2.count({ where: { trigger_entity_id: pending.owner_appointment_id } }), 1);
        assert.equal(await db.JobRequest.count({ where: { payload: { execution_id: Number(pending.execution_id) } } }), 1);
        const recoveredItem = await materialize(pending.owner_appointment_id);
        assert.equal((await f.claimAndHandle(recoveredItem.deliver.id)).result.outcome, 'accepted'); assert.equal(f.attempts.length, 2);
        context.report.checks.push('Crash seam AFTER native commit BEFORE enqueue + real response ECONNRESET: parent replay no hooks, restart+four concurrent existing managed discovery calls produce one execution/job, actual flow/broker publishes the persisted intent once');

        const multiVoucher = await f.voucher({ patient_id: 3, treatment_id: 2 });
        const multi = await prepare(multiVoucher, f.payload({ start_at: '2030-01-09T09:00:00Z', count: 2,
          duration_minutes: undefined, phase_durations: { one: 40, two: 20 }, doctor_id: undefined, installation_id: undefined }));
        const preMulti = await f.counts(), multiResult = await commit(multiVoucher, multi);
        assert.equal(multiResult.body.created.length, 2); assert.equal((await f.counts()).AppointmentVisit, preMulti.AppointmentVisit + 2);
        const multiVisits = await Promise.all(multiResult.body.created.map(row => visitFor(row.id)));
        assert.equal(new Set(multiVisits.map(row => row.runtime_enrollment.birth_request_key)).size, 2);
        assert.deepEqual(multiVisits.map(row => row.runtime_enrollment.origin.sequence), [1, 2]);
        assert(multiVisits.every(row => row.snapshot.reservations[0].booking.steps.length === 2));
        context.report.checks.push('Two multi-step v4 sessions create TWO independent singleton visits/private child request keys; whole phases/offsets remain frozen and the original parent HTTP receipt aggregates them');

        // Fail AFTER native intent INSERT and AFTER aggregate receipt INSERT:
        // all managed identity/physical rows roll back, only preview survives.
        for (const point of ['intent', 'receipt']) {
          const rollbackVoucher = await f.voucher({ patient_id: 4 }), rollback = await prepare(rollbackVoucher,
            f.payload({ start_at: point === 'intent' ? '2030-01-10T09:00:00Z' : '2030-01-11T09:00:00Z', count: 2 }));
          const before = await f.counts(); let seen = 0;
          const model = point === 'intent' ? db.AppointmentVisitCommunication : db.PatientOperationalEvent, original = model.create;
          model.create = async function(values, options) {
            const result = await original.call(this, values, options);
            if (point === 'intent' && ++seen === 2 || point === 'receipt' && values.event_type === replay.eventType('committed', rollback.proposal.booking_request_key)) throw Error('OWNED_AFTER_' + point);
            return result;
          };
          try { assert.equal((await f.request(rollbackVoucher, 'appointments', rollback.payload)).status, 500); }
          finally { model.create = original; }
          assert.deepEqual(await f.counts(), before); assert.equal((await commit(rollbackVoucher, rollback)).body.created.length, 2);
        }
        context.report.checks.push('Native failure injected AFTER second intent INSERT and AFTER committed aggregate receipt INSERT rolls back Citas/occupancy/anchors/member/visit/birth receipt/intents/aggregate ledger together; retry uses original prepared request and creates exactly the intended batch');

        // Current mutation revision protects birth origin without requiring its
        // old time to equal a legitimate new time; A→B→A never revives rev1.
        const movedVoucher = await f.voucher({ patient_id: 4 }), moved = await prepare(movedVoucher,
          f.payload({ start_at: '2030-01-14T09:00:00Z' }));
        f.state.crashBeforeEnqueue = true; const movedResult = await commit(movedVoucher, moved); f.state.crashBeforeEnqueue = false;
        const movedId = movedResult.body.created[0].id;
        for (const inicio of ['2030-01-14T10:00:00Z', '2030-01-14T09:00:00Z']) {
          const movedResponse = await f.patch(movedId, 'move', { inicio, fin: new Date(Date.parse(inicio) + 45 * 60000).toISOString(),
            reschedule_reason: 'administrative_error', doctor_id: 1, instalacion_id: 101 });
          assert.equal(movedResponse.statusCode, 200, JSON.stringify(movedResponse));
        }
        const changedVisit = await visitFor(movedId); assert.equal(Number(changedVisit.communication_revision), 3);
        const oldIntent = await db.AppointmentVisitCommunication.findOne({ where: { owner_appointment_id: movedId, communication_revision: 1 } });
        assert.equal(oldIntent.status, 'cancelled');
        const beforeABA = await f.counts(); await f.managed.reconcilePendingBirthIntents({ runtimeNamespace: 'visit_fixture', limit: 100 });
        assert.equal(await db.FlowExecutionV2.count({ where: { trigger_entity_id: movedId } }), 0);
        const parentReplay = await f.request(movedVoucher, 'appointments', moved.payload); assert.equal(parentReplay.status, 200);
        assert.deepEqual(parentReplay.body.created, movedResult.body.created); assert.deepEqual(await f.counts(), beforeABA);
        context.report.checks.push('Actual move endpoint A→B→A with administrative suppression advances communication revision1→3; old birth intent remains cancelled and managed discovery/parent replay cannot restore it or reenqueue');

        const cancelledVoucher = await f.voucher({ patient_id: 4 }), cancelled = await prepare(cancelledVoucher,
          f.payload({ start_at: '2030-01-15T09:00:00Z' }));
        f.state.crashBeforeEnqueue = true; const cancelledResult = await commit(cancelledVoucher, cancelled); f.state.crashBeforeEnqueue = false;
        const cancelledId = cancelledResult.body.created[0].id;
        const cancelledResponse = await f.patch(cancelledId, 'state', { estado: 'cancelada' });
        assert.equal(cancelledResponse.statusCode, 200, JSON.stringify(cancelledResponse));
        const birthIntent = await db.AppointmentVisitCommunication.findOne({ where: { owner_appointment_id: cancelledId, communication_revision: 1 } });
        assert.equal(birthIntent.status, 'cancelled');
        const cancelReplay = await f.request(cancelledVoucher, 'appointments', cancelled.payload); assert.equal(cancelReplay.status, 200);
        assert.deepEqual(cancelReplay.body.created, cancelledResult.body.created); assert.equal((await db.CitaPaciente.findByPk(cancelledId)).estado, 'cancelada');
        context.report.checks.push('Actual cancellation endpoint retires rev1 birth right; aggregate voucher replay returns original receipt without reopening Cita or reviving intent');

        const unknownVoucher = await f.voucher({ patient_id: 2 }), unknown = await prepare(unknownVoucher,
          f.payload({ start_at: '2030-01-23T09:00:00Z' }));
        const unknownResult = await commit(unknownVoucher, unknown), unknownItem = await materialize(unknownResult.body.created[0].id);
        f.provider('unknown'); const attempts = f.attempts.length;
        assert.equal((await f.claimAndHandle(unknownItem.deliver.id)).result.outcome, 'unknown');
        await f.jobs.setPending(unknownItem.deliver.id); assert.equal((await f.claimAndHandle(unknownItem.deliver.id)).result.reason, 'unknown');
        assert.equal((await f.request(unknownVoucher, 'appointments', unknown.payload)).status, 200); assert.equal(f.attempts.length, attempts + 1);
        f.provider('accept');
        context.report.checks.push('Actual voucher flow/network-start fake failure yields unknown; dispatch retry and parent POST replay preserve the same Message/receipt and never attempt a second send');

        for (const mode of ['closed', 'registry', 'legacy']) {
          const outsideVoucher = await f.voucher({ patient_id: 2, ...(mode === 'legacy' ? { treatment_id: 4 } : {}) });
          const outside = await prepare(outsideVoucher, f.payload({ start_at: mode === 'closed' ? '2030-01-24T09:00:00Z'
            : mode === 'registry' ? '2030-01-25T09:00:00Z' : '2030-01-28T09:00:00Z', duration_minutes: mode === 'legacy' ? 30 : 45 }));
          const before = await db.AppointmentVisit.count();
          if (mode === 'closed') f.enable(false);
          if (mode === 'registry') f.registry([]);
          await commit(outsideVoucher, outside); assert.equal(await db.AppointmentVisit.count(), before);
          if (mode === 'closed') f.enable(true);
          if (mode === 'registry') { // Restore only the already reviewed OWNED registry.
            const template = await db.AutomationFlowTemplateV2.findByPk(42);
            f.registry([{ clinic_id: 100, template_version_id: 42, graph_sha256: require('../../lib/appointment-visit-runtime-contract').graphHash(template),
              stages: [{ key: 'details', node_ids: ['S'] }], mutations: [] }]);
          }
        }
        const historical = await db.CitaPaciente.create(f.physical.values({ tratamiento_id: 1, voucher_id: voucher.id,
          source_system: 'cliniccloud', source_reference: 'old-native-id', inicio: '2030-01-29T09:00:00Z', fin: '2030-01-29T09:45:00Z' }));
        const direct = await f.managed.prepareVoucherBirth({ values: historical.toJSON(), clinic: await db.Clinica.findByPk(100), actorId: 1,
          profile: singleProfile(appointment), parentRequestKey: planned.proposal.booking_request_key });
        assert.equal(direct, null); assert.equal(await db.AppointmentVisitMember.findByPk(historical.id_cita), null);
        context.report.checks.push('CLOSED existing gate, missing reviewed registry, v1 fixed profile and preexisting imported appointment remain unenrolled; unsupported paths preserve legacy booking compatibility without pretending durable managed notice coverage');

        // A graph changing after the opaque enrollment proof was prepared is
        // rejected by the existing native core verification before Cita INSERT.
        const graphVoucher = await f.voucher({ patient_id: 2 }), graphPlan = await prepare(graphVoucher,
          f.payload({ start_at: '2030-01-30T09:00:00Z' }));
        const graphCounts = await f.counts(), originalFind = db.AppointmentVisitBirthRequest.findOrCreate;
        db.AppointmentVisitBirthRequest.findOrCreate = async function(options) {
          const result = await originalFind.call(this, options), template = await db.AutomationFlowTemplateV2.findByPk(42, { transaction: options.transaction });
          const nodes = structuredClone(template.nodes); nodes.find(row => row.id === 'S').config.owned_change_after_proof = true;
          await template.update({ nodes }, { transaction: options.transaction }); return result;
        };
        try {
          const denied = await f.request(graphVoucher, 'appointments', graphPlan.payload);
          assert.equal(denied.status, 409, JSON.stringify(denied)); assert.equal(denied.body.code, 'appointment_visit_runtime_graph_changed');
        } finally { db.AppointmentVisitBirthRequest.findOrCreate = originalFind; }
        assert.deepEqual(await f.counts(), graphCounts);
        context.report.checks.push('Native reviewed graph changed AFTER opaque prepare but before core Cita INSERT:409 graph_changed rolls back private receipt and graph edit; no appointment/member/intent/occupancy/aggregate ledger survives');

        const preparedEvent = await db.PatientOperationalEvent.findOne({ where: { event_type: replay.eventType('prepared', planned.proposal.booking_request_key) } });
        const committedEvent = await db.PatientOperationalEvent.findOne({ where: { event_type: replay.eventType('committed', planned.proposal.booking_request_key) } });
        const committedSaved = committedEvent.metadata;
        // Raw SQL fault injection ONLY in this freshly owned schema: the real
        // append-only model correctly refuses UPDATE, so don't relax its hooks.
        await db.sequelize.query('UPDATE PatientOperationalEvents SET metadata = :metadata WHERE id = :id', {
          replacements: { id: committedEvent.id, metadata: JSON.stringify({ ...committedSaved, receipt_sha256: '0'.repeat(64) }) } });
        try {
          await assert.rejects(db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, transaction => createVoucherBookingOriginReader({ db })
            .forVisit({ visit: visit, appointment, transaction })), /resultado guardado/);
        } finally { await db.sequelize.query('UPDATE PatientOperationalEvents SET metadata = :metadata WHERE id = :id', {
          replacements: { id: committedEvent.id, metadata: JSON.stringify(committedSaved) } }); }
        assert.equal(String(preparedEvent.id), visit.runtime_enrollment.origin.prepared_event_id);
        context.report.checks.push('Consumer origin proof rereads actual prepared/committed native ledger and rejects tampered aggregate receipt even for an already enrolled visit; no caller boolean or origin JSON grants eligibility');

        const teamProfile = f.physical.profile(4, [f.physical.phase('team', { duration_minutes: 30, start_offset_minutes: 0,
          professionals: { mode: 'all', ids: [1, 2] } })]);
        await db.Tratamiento.create({ id_tratamiento: 6, clinica_id: 100, grupo_clinica_id: 50, nombre: 'Equipo ficticio obligatorio',
          origen: 'clinica', activo: true, clinical_config: { catalog_status: 'active', booking_profile: teamProfile },
          appointment_automation_template_key: 'owned_visit_details' });
        const teamVoucher = await f.voucher({ treatment_id: 6, patient_id: 3, source_system: 'clinicaclick', source_reference: 'manual-old-purchase' });
        const teamPlan = await prepare(teamVoucher, f.payload({ start_at: '2030-01-31T09:00:00Z', duration_minutes: 30,
          doctor_id: undefined, installation_id: undefined }));
        const teamResult = await commit(teamVoucher, teamPlan), teamId = teamResult.body.created[0].id;
        const teamVisit = await visitFor(teamId), teamRows = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: teamId }, raw: true });
        assert.equal(teamVisit.snapshot.reservations[0].booking.steps.length, 1);
        assert.deepEqual(teamVisit.snapshot.reservations[0].booking.steps[0].doctor_ids, [1, 2]);
        assert.deepEqual(teamRows.filter(row => row.doctor_id != null).map(row => Number(row.doctor_id)).sort(), [1, 2]);
        assert.equal(teamVisit.runtime_enrollment.origin.purchase_references.source_reference, 'manual-old-purchase');
        assert.deepEqual((await f.runtime.syncScheduledTriggersForCita(await db.CitaPaciente.findByPk(teamId))).reminder_intents, []);
        context.report.checks.push('NEW v4 individual ALL team from a manual existing purchase uses the same managed singleton path: two actual doctor occupancy rows, whole mandatory team frozen, one voucher session and one notice intent, no commercial purchase reinterpretation');

        const emptySchedule = await f.runtime.syncScheduledTriggersForCita(appointment);
        assert.deepEqual(emptySchedule.reminder_intents, []); assert.deepEqual(emptySchedule.scheduled_jobs, []);
        context.report.checks.push('No native reminder graph is selected in this origin-only fixture: new enrollment freezes an explicit empty pin and synchronization creates no jobs/intents; reminder delivery coverage is tested separately');
        context.report.voucherVisitOriginChecks = context.report.checks.length;
        context.report.fakeProviderAttempts = f.attempts.length;
        context.report.boundary = 'HTTP controllers/domain services/physical solver/native SQL/managed recovery/job handler/flow/common sender/final broker real; session ACL and documentation/realtime synthetic, broker transport fictional. No full app authentication, clinical approval, production flags or real delivery asserted. This fixture has no selected reminder graph; managed reminder delivery is proven separately.';
      } finally { await f.close(); }
    });
  });
function singleProfile(appointment) { return appointment.import_metadata.booking.profile; }
