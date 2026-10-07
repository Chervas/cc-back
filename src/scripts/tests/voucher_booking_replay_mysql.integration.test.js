'use strict';

// Explicit opt-in: freshly owned mysqld/private Unix socket/--skip-networking.
// Actual voucher HTTP controllers, services, solver, transactions and models;
// session ACL and post-commit document/provider hooks are declared synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVoucherReplayFixture } = require('./helpers/owned-voucher-replay-fixture');
const replay = require('../../lib/voucher-booking-replay');

test('simple voucher durable request: actual HTTP -> native SQL receipt, replay, scope, atomicity, duration and physical resources',
  { skip: process.env.VOUCHER_BOOKING_REPLAY_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql, models, report, registerOwnedLoopbackServer }) => {
      const f = await createOwnedVoucherReplayFixture({ sql, models, registerOwnedLoopbackServer });
      try {
        const voucher = await f.voucher(), body = f.payload();
        const baseline = await f.counts();
        const missing = await f.request(voucher, 'appointment-plan', f.payload({ duration_minutes: undefined }));
        assert.equal(missing.status, 422); assert.equal(missing.body.code, 'booking_duration_required');
        assert.equal((await f.request(voucher, 'appointments', body)).status, 400);
        assert.deepEqual(await f.counts(), baseline);
        report.checks.push('Duración NULL sin elección explícita y create sin identidad:422/400 reales, cero citas/ocupación/ledger; no default30');

        const proposal = await f.request(voucher, 'appointment-plan', body);
        assert.equal(proposal.status, 200, JSON.stringify(proposal)); assert.equal(proposal.body.has_conflicts, false);
        assert.match(proposal.body.booking_request_key, /^[a-f0-9-]{36}$/); assert.match(proposal.body.booking_request_sha256, /^[a-f0-9]{64}$/);
        assert.equal(f.state.serviceCalls.at(-1).actor, 1);
        const request = f.sealed(body, proposal.body), purchased = (await voucher.reload()).toJSON();
        const [a, b] = await Promise.all([f.request(voucher, 'appointments', request), f.request(voucher, 'appointments', request)]);
        assert.deepEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a, b]));
        const first = [a, b].find(result => result.status === 201), repeat = [a, b].find(result => result.status === 200);
        assert.deepEqual(first.body.created, repeat.body.created); assert.equal(repeat.body.replayed, true);
        assert.equal(repeat.body.documentation_review_required, true);
        const appointment = first.body.created[0].id, saved = await f.base.read(appointment);
        assert.equal(saved.voucher_id, voucher.id); assert.equal(saved.import_metadata.booking.duration_selection.duration_minutes, 45);
        assert.equal((await f.base.occupancy(appointment)).length, 2);
        assert.equal((await f.counts()).CitaPaciente, baseline.CitaPaciente + 1);
        assert.equal(await models.PatientOperationalEvent.count({ where: { event_type: replay.eventType('committed', proposal.body.booking_request_key) } }), 1);
        assert.deepEqual((await voucher.reload()).toJSON(), purchased); assert.equal(await models.PatientVoucherMovement.count(), 0);
        assert.equal(f.state.automation.length, 2); assert.equal(f.state.documents.length, 1); assert.equal(f.state.realtime.length, 1);
        report.checks.push('Dos POST concurrentes:201+200, una cita y receipt en mismaTx, actor1, dos filas físicas, saldo/compra/consumo intactos; hooks sólo primercommit');

        const committedCounts = await f.counts(), hooks = [f.state.automation.length, f.state.documents.length, f.state.realtime.length];
        const otherActor = await f.request(voucher, 'appointments', request, { actor: 2 });
        assert.equal(otherActor.status, 403); assert.equal(otherActor.body.code, 'voucher_booking_request_forbidden');
        const beforeAcl = f.state.serviceCalls.length;
        assert.equal((await f.request(voucher, 'appointments', request, { actor: 3 })).status, 403);
        assert.equal(f.state.serviceCalls.length, beforeAcl);
        const foreign = await f.voucher({ clinic_id: 200, treatment_id: 11, patient_id: 2 });
        assert.equal((await f.request(foreign, 'appointments', request)).status, 403);
        assert.equal(f.state.serviceCalls.length, beforeAcl);
        for (const patch of [{ start_at: '2030-01-07T10:00:00Z' }, { duration_minutes: 30 }, { count: 2 }, { doctor_id: 2 },
          { booking_request_sha256: '0'.repeat(64) }, { booking_request_key: crypto.randomUUID() },
          { booking_selection: { care: { installation_id: 102 } } }]) {
          assert.equal((await f.request(voucher, 'appointments', { ...request, ...patch })).status, 409);
        }
        assert.deepEqual(await f.counts(), committedCounts);
        assert.deepEqual([f.state.automation.length, f.state.documents.length, f.state.realtime.length], hooks);
        report.checks.push('Actor/scope: usuario2 no roba identidad, usuario3/clínica200 ACL antes servicio; fecha/duración/recurso/hash/UUID ajenos no regeneran cita ni hooks');

        // A lost native HTTP response happens after SQL COMMIT and post-commit
        // spies. Retrying this exact identity must return the stored receipt.
        const lostVoucher = await f.voucher({ patient_id: 2 }), lostBody = f.payload({ start_at: '2030-01-08T09:00:00Z' });
        const lostProposal = await f.request(lostVoucher, 'appointment-plan', lostBody);
        assert.equal(lostProposal.status, 200); const lostRequest = f.sealed(lostBody, lostProposal.body);
        await assert.rejects(f.request(lostVoucher, 'appointments', lostRequest, { drop: true }), { code: 'ECONNRESET' });
        const lostCounts = await f.counts(), lostHooks = [f.state.automation.length, f.state.documents.length, f.state.realtime.length];
        const recovered = await f.request(lostVoucher, 'appointments', lostRequest);
        assert.equal(recovered.status, 200); assert.equal(recovered.body.replayed, true); assert.equal(recovered.body.created.length, 1);
        assert.deepEqual(await f.counts(), lostCounts);
        assert.deepEqual([f.state.automation.length, f.state.documents.length, f.state.realtime.length], lostHooks);
        report.checks.push('Respuesta HTTP real destruida trascommit:ECONNRESET→mismoPOST recupera200, misma cita/receipt, cero duplicados/cobros/documentos/realtime');

        await f.base.reserve({ existingAppointmentId: appointment, appointmentValues: { estado: 'cancelada' } });
        await models.Tratamiento.update({ nombre: 'Catálogo cambiado NO receipt', clinical_config: { catalog_status: 'active', booking_profile: f.base.profile(1,
          [f.base.phase('changed', { duration_minutes: 20, installation_ids: [102] })]) } }, { where: { id_tratamiento: 1 } });
        await voucher.update({ status: 'cancelled', available_units: 0, expires_at: new Date('2020-01-01') });
        const beforeHistorical = await f.counts(), history = await f.base.read(appointment);
        const historical = await f.request(voucher, 'appointments', request);
        assert.equal(historical.status, 200); assert.deepEqual(historical.body.created, first.body.created);
        assert.deepEqual(await f.base.read(appointment), history); assert.deepEqual(await f.counts(), beforeHistorical);
        assert.equal(historical.body.documentation_review_required, true); assert.equal(history.estado, 'cancelada');
        report.checks.push('Receipt precede catálogo/estado/saldo/expiry mutable: cita cancelada no se reabre ni redimensiona y documentos no se reconstruyen');

        // Restore template ONLY in this synthetic private database for further
        // scenarios; this is not a production migration or catalog activation.
        await models.Tratamiento.update({ nombre: 'Tratamiento sintético 1', clinical_config: { catalog_status: 'active', booking_profile: f.base.profile() } }, { where: { id_tratamiento: 1 } });
        const rollbackVoucher = await f.voucher({ patient_id: 3 }), rollbackBody = f.payload({ count: 2, start_at: '2030-01-09T09:00:00Z' });
        const rollbackProposal = await f.request(rollbackVoucher, 'appointment-plan', rollbackBody);
        assert.equal(rollbackProposal.status, 200); const rollbackRequest = f.sealed(rollbackBody, rollbackProposal.body);
        const beforeRollback = await f.counts(); let writes = 0;
        models.CitaPaciente.addHook('afterCreate', 'owned-voucher-fail-second', () => { if (++writes === 2) throw Error('OWNED_SECOND_APPOINTMENT_FAILURE'); });
        try { assert.equal((await f.request(rollbackVoucher, 'appointments', rollbackRequest)).status, 500); }
        finally { models.CitaPaciente.removeHook('afterCreate', 'owned-voucher-fail-second'); }
        assert.deepEqual(await f.counts(), beforeRollback);
        const retried = await f.request(rollbackVoucher, 'appointments', rollbackRequest);
        assert.equal(retried.status, 201, JSON.stringify(retried)); assert.equal(retried.body.created.length, 2);
        report.checks.push('Fallo afterCreate de segunda cita revierte primera cita, ocupación, anchors y committedreceipt; prepared sobrevive y reintento crea exactamente2');

        const relativeVoucher = await f.voucher({ patient_id: 4, treatment_id: 2 }), relativeBody = f.payload({ start_at: '2030-01-10T09:00:00Z',
          duration_minutes: undefined, doctor_id: undefined, installation_id: undefined, phase_durations: { one: 40, two: 20 } });
        const relativeProposal = await f.request(relativeVoucher, 'appointment-plan', relativeBody);
        assert.equal(relativeProposal.status, 200, JSON.stringify(relativeProposal)); assert.equal(relativeProposal.body.configuration.duration_minutes, 40);
        const relative = await f.request(relativeVoucher, 'appointments', f.sealed(relativeBody, relativeProposal.body));
        assert.equal(relative.status, 201, JSON.stringify(relative));
        const relativeSaved = await f.base.read(relative.body.created[0].id);
        assert.equal(new Date(relativeSaved.fin).toISOString(), '2030-01-10T09:40:00.000Z');
        assert.deepEqual(relativeSaved.import_metadata.booking.profile.phases.map(row => row.start_offset_minutes), [0, 15]);
        assert.equal(relativeSaved.import_metadata.booking.capacity_fully_verified, true);
        report.checks.push('Bono físicoV4 variable: minutos por paso40/20, offsets0/15, span40 y selección completa se congelan; no suma60 ni primerpaso ficticio');

        const machineVoucher = await f.voucher({ treatment_id: 3 }), machineBody = f.payload({ start_at: '2030-01-11T09:00:00Z' });
        const machineProposal = await f.request(machineVoucher, 'appointment-plan', machineBody);
        assert.equal(machineProposal.status, 200); const machineRequest = f.sealed(machineBody, machineProposal.body);
        const machine = await f.request(machineVoucher, 'appointments', machineRequest);
        assert.equal(machine.status, 201, JSON.stringify(machine));
        assert((await f.base.occupancy(machine.body.created[0].id)).some(row => row.resource_key === 'equipment:401'
          && new Date(row.end_at).toISOString() === '2030-01-11T09:55:00.000Z'));
        const peer = await f.voucher({ treatment_id: 12, patient_id: 2 }), peerBody = f.payload({ start_at: '2030-01-11T09:45:00Z', doctor_id: 2, installation_id: 102, duration_minutes: 30 });
        const conflict = await f.request(peer, 'appointment-plan', peerBody);
        assert.equal(conflict.status, 200); assert.equal(conflict.body.has_conflicts, true); assert.equal(conflict.body.booking_request_key, undefined);
        report.checks.push('Unidad401/turnaround10 SQL: otra sala/profesional no libera máquina; preview conflictivo sin sello, no crea falsa capacidad');

        const physicalPeer = await f.base.reserve({ appointmentValues: f.base.values({ clinica_id: 200, tratamiento_id: 11,
          doctor_id: 2, instalacion_id: 201, paciente_id: 2, inicio: '2030-01-14T09:00:00Z', fin: null }), durationSelection: { duration_minutes: 45 } });
        assert((await f.base.occupancy(physicalPeer.id_cita)).some(row => row.resource_key === 'installation:101'));
        const aliasVoucher = await f.voucher({ treatment_id: 4, patient_id: 3 });
        const aliasConflict = await f.request(aliasVoucher, 'appointment-plan', f.payload({ start_at: '2030-01-14T09:00:00Z', duration_minutes: 30 }));
        assert.equal(aliasConflict.body.has_conflicts, true); assert.equal(aliasConflict.body.booking_request_key, undefined);
        assert.doesNotMatch(JSON.stringify(aliasConflict.body.appointments), /patient_id|paciente_id|Clínica ficticia 200/);
        report.checks.push('Alias físico entre clínicas201→101 conserva ocupación real: profesional distinto no libera sala ni revela paciente ajeno');

        await models.Tratamiento.create({ id_tratamiento: 6, clinica_id: 100, grupo_clinica_id: 50, nombre: 'Equipo ALL sintético',
          origen: 'clinica', activo: true, clinical_config: { catalog_status: 'active', booking_profile: f.base.profile(4,
            [f.base.phase('team', { installation_ids: [102], professionals: { mode: 'all', ids: [1, 2], preferred_id: null } })]) } });
        const teamVoucher = await f.voucher({ treatment_id: 6, patient_id: 4 }), teamBody = f.payload({ start_at: '2030-01-15T09:00:00Z',
          doctor_id: undefined, installation_id: undefined, duration_minutes: 30 });
        const teamProposal = await f.request(teamVoucher, 'appointment-plan', teamBody);
        assert.equal(teamProposal.status, 200, JSON.stringify(teamProposal)); assert.equal(teamProposal.body.has_conflicts, false);
        const team = await f.request(teamVoucher, 'appointments', f.sealed(teamBody, teamProposal.body));
        assert.equal(team.status, 201, JSON.stringify(team));
        const teamRows = await f.base.occupancy(team.body.created[0].id);
        assert.deepEqual(teamRows.filter(row => row.resource_kind === 'doctor').map(row => row.resource_key).sort(), ['doctor:1', 'doctor:2']);
        assert.equal(teamRows.filter(row => row.resource_kind === 'installation').length, 1);
        report.checks.push('Equipo ALL real enV4: una cita con dos profesionales y una sala, no estrecha al prioritario ni crea dos cobros/sesiones');

        const staleVoucher = await f.voucher({ treatment_id: 4 }), staleBody = f.payload({ start_at: '2030-01-17T09:00:00Z', duration_minutes: 30 });
        const staleProposal = await f.request(staleVoucher, 'appointment-plan', staleBody);
        assert.equal(staleProposal.body.has_conflicts, false); const beforeStale = await f.counts();
        await models.Tratamiento.update({ nombre: 'Revisión posterior sin aprobar reserva' }, { where: { id_tratamiento: 4 } });
        const stale = await f.request(staleVoucher, 'appointments', f.sealed(staleBody, staleProposal.body));
        assert.equal(stale.status, 409); assert.equal(stale.body.code, 'voucher_booking_plan_changed');
        assert.deepEqual(await f.counts(), beforeStale);
        report.checks.push('Nueva reserva con ficha revisada después de preview:409 plan_changed, cero citas/receipt; nunca reinterpreta la compra ni ignora el sello');

        // Native SQL interleaving AFTER the series was solved but BEFORE the
        // canonical resource-locked solver re-reads the machine. The expected
        // full-plan hash must reject a newly changed turnaround, not create a
        // different receipt just because the interval remains otherwise free.
        const raceVoucher = await f.voucher({ treatment_id: 3 }), raceBody = f.payload({ start_at: '2030-01-18T09:00:00Z' });
        const raceProposal = await f.request(raceVoucher, 'appointment-plan', raceBody);
        assert.equal(raceProposal.body.has_conflicts, false); const beforeRace = await f.counts();
        let release, reached; const barrier = new Promise(resolve => { release = resolve; }), atLock = new Promise(resolve => { reached = resolve; });
        let stopped = false, inFlight;
        models.AppointmentBookingResource.addHook('afterFind', 'owned-voucher-resource-race', async (row, options) => {
          if (!stopped && row?.resource_key === 'equipment:401' && options.lock === 'UPDATE') {
            stopped = true; reached(); await barrier;
          }
        });
        try {
          inFlight = f.request(raceVoucher, 'appointments', f.sealed(raceBody, raceProposal.body));
          await Promise.race([atLock, new Promise((_, reject) => setTimeout(() => reject(Error('OWNED_RESOURCE_LOCK_NOT_REACHED')), 3000))]);
          await models.BookingEquipment.update({ turnaround_minutes: 20 }, { where: { id: 401 } });
          release(); const changed = await inFlight;
          assert.equal(changed.status, 409, JSON.stringify(changed)); assert.equal(changed.body.code, 'booking_plan_changed');
          assert.deepEqual(await f.counts(), beforeRace);
        } finally {
          release(); models.AppointmentBookingResource.removeHook('afterFind', 'owned-voucher-resource-race');
          if (inFlight) await inFlight;
        }
        await models.BookingEquipment.update({ turnaround_minutes: 10 }, { where: { id: 401 } });
        report.checks.push('CAS plan completo real: turnaround cambia10→20 entre plan y locks; canonical re-solve detecta hash distinto y revierte cita/receipt/ocupación');

        const receiptVoucher = await f.voucher({ treatment_id: 4 }), receiptBody = f.payload({ start_at: '2030-01-21T09:00:00Z', duration_minutes: 30 });
        const receiptProposal = await f.request(receiptVoucher, 'appointment-plan', receiptBody);
        const beforeReceipt = await f.counts();
        models.PatientOperationalEvent.addHook('beforeCreate', 'owned-voucher-receipt-fail', row => {
          if (row.event_type.startsWith('voucher.booking.committed.')) throw Error('OWNED_COMMITTED_RECEIPT_FAILURE');
        });
        try { assert.equal((await f.request(receiptVoucher, 'appointments', f.sealed(receiptBody, receiptProposal.body))).status, 500); }
        finally { models.PatientOperationalEvent.removeHook('beforeCreate', 'owned-voucher-receipt-fail'); }
        assert.deepEqual(await f.counts(), beforeReceipt);
        report.checks.push('Fallo al guardar committedreceipt después de citas/ocupación revierte TODA laTx; ninguna cita sin identidad durable ni contador parcial');

        const docsVoucher = await f.voucher({ treatment_id: 4, patient_id: 2 }), docsBody = f.payload({ start_at: '2030-01-23T09:00:00Z', duration_minutes: 30 });
        const docsProposal = await f.request(docsVoucher, 'appointment-plan', docsBody), docsRequest = f.sealed(docsBody, docsProposal.body);
        f.state.failDocuments = true;
        let documentation;
        try { documentation = await f.request(docsVoucher, 'appointments', docsRequest); }
        finally { f.state.failDocuments = false; }
        assert.equal(documentation.status, 201); assert.deepEqual(documentation.body.documentation_pending, documentation.body.created.map(row => row.id));
        const docsCalls = f.state.documents.length, rtCalls = f.state.realtime.length;
        const docsReplay = await f.request(docsVoucher, 'appointments', docsRequest);
        assert.equal(docsReplay.status, 200); assert.equal(docsReplay.body.documentation_review_required, true);
        assert.deepEqual(docsReplay.body.created, documentation.body.created);
        assert.equal(f.state.documents.length, docsCalls); assert.equal(f.state.realtime.length, rtCalls);
        report.checks.push('Hook documental fallido trascommit conserva201 documentation_pending; replay200 pide revisar documentación sin regenerarla desde catálogo ni republish realtime');

        const [indexes] = await sql.query('SHOW INDEX FROM PatientOperationalEvents');
        assert.deepEqual(indexes.filter(row => row.Key_name === 'idx_patient_operational_events_patient_type_at').sort((a, b) => a.Seq_in_index - b.Seq_in_index)
          .map(row => row.Column_name), ['patient_id', 'clinic_id', 'event_type', 'occurred_at']);
        const [explain] = await sql.query('EXPLAIN SELECT id FROM PatientOperationalEvents WHERE patient_id=? AND clinic_id=? AND event_type=? AND source=? ORDER BY occurred_at DESC,id DESC LIMIT 2',
          { replacements: [1, 100, replay.eventType('committed', proposal.body.booking_request_key), replay.SOURCE] });
        assert.match(explain[0].possible_keys, /idx_patient_operational_events_patient_type_at/);
        report.checks.push('Lookup realexacto UUID enevent_type ytenant, LIMIT2: índice existente patient/clinic/type/time comprobado por SHOW INDEX y EXPLAIN; no JSONscan/DDL nueva');

        const beforeClosed = await f.counts(); f.state.enabled = false;
        let ledgerQueries = 0;
        models.PatientOperationalEvent.addHook('beforeFind', 'owned-voucher-closed-no-ledger', () => { ledgerQueries++; });
        try {
          const disabled = await f.request(lostVoucher, 'appointments', lostRequest);
          assert.equal(disabled.status, 409); assert.equal(disabled.body.code, 'voucher_booking_replay_disabled');
          const oldPreview = await f.request(receiptVoucher, 'appointment-plan', f.payload({ start_at: '2030-01-22T09:00:00Z', duration_minutes: 30 }));
          assert.equal(oldPreview.status, 200); assert.equal(oldPreview.body.has_conflicts, false);
          assert.equal(oldPreview.body.booking_request_key, undefined); assert.equal(oldPreview.body.booking_replay_supported, undefined);
          assert.equal(ledgerQueries, 0);
        } finally { models.PatientOperationalEvent.removeHook('beforeFind', 'owned-voucher-closed-no-ledger'); }
        assert.deepEqual(await f.counts(), beforeClosed);
        report.checks.push('Compuerta por defecto cerrada: request sellado rechaza409, preview legacy conserva DTO y no consulta ledger; sin fallback/escrituras/variables reales');
        report.boundary = 'HTTP/controllers/service/solver/MySQL reales en socket OWNED y loopback propio; ACL y hooks documentación/automatización son spies sintéticos, no prueba autenticación completa ni envío/provider. Crash postcommit antes enqueue requiere recuperación independiente y no se promete aquí.';
        report.voucherReplayChecks = report.checks.length;
      } finally { await f.close(); }
    });
  });
