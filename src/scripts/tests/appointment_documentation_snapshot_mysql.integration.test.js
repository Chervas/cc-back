'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedConsentConsistencyFixture } = require('./helpers/owned-consent-consistency-fixture');
const { createTreatmentDocumentationService } = require('../../services/treatmentDocumentation.service');
const { digest } = require('../../lib/appointment-documentation-snapshot');

test('clinical start preserves exact approved protocol references atomically in native OWNED SQL',
  { skip: process.env.APPOINTMENT_DOCUMENTATION_SNAPSHOT_MYSQL_TEST !== '1', timeout: 180000 }, async () => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createOwnedConsentConsistencyFixture(context), { db, care } = f;
      const docs = createTreatmentDocumentationService(db), observations = context.report.observations = [];
      const check = (name, actual) => { observations.push({ name, passed: true, actual }); };
      // These are synthetic test approvals through the REAL service, never
      // approvals of client documents or real clinical instructions.
      await db.Tratamiento.create({ id_tratamiento: 17, clinica_id: 100, nombre: 'Técnica ficticia sin requisitos',
        origen: 'clinica', activo: true, precio_base: 19, eliminado_por_clinica: [] });
      const save = (treatmentIds, index, patch = {}) => docs.save({ clinicId: 100, actorId: 7, payload: {
        title: 'Documento ficticio ' + index, kind: index % 2 ? 'protocol' : 'aftercare', status: 'approved',
        content: 'Texto OWNED ficticio, no instrucciones clínicas reales. ' + index,
        source: 'Sólo pruebas OWNED ' + index, treatment_ids: treatmentIds, ...patch } });
      const approved = [];
      for (let index = 1; index <= 12; index++) approved.push((await save([17], index)).item);
      await save([17], 13, { status: 'draft', content: 'BORRADOR_NO_MOSTRAR' });
      await docs.save({ clinicId: 200, actorId: 8, payload: { title: 'Otra clínica', kind: 'protocol', status: 'approved',
        content: 'OTRA_CLINICA_NO_MOSTRAR', source: 'OWNED clínica B', treatment_ids: [] } });
      const cita = await f.appointment(17, { notas: 'Notas ficticias conservadas', precio_final: 19,
        import_metadata: { physical_only: { label: 'No es otro tratamiento', treatment_id: 999 } } });
      await f.arrive(cita);
      const startBefore = (await db.CitaPaciente.findByPk(cita.id_cita)).toJSON();
      const first = await f.start(cita);
      assert.equal(first.replayed, false);
      const started = (await db.CitaPaciente.findByPk(cita.id_cita)).toJSON();
      for (const key of ['inicio', 'fin', 'estado', 'notas', 'precio_final', 'tratamiento_id', 'voucher_id', 'import_metadata']) {
        assert.deepEqual(started[key], startBefore[key], key + ' is not a clinical-start mutation');
      }
      const op = await db.PatientOperationalEvent.findOne({ where: { patient_id: 1, clinic_id: 100,
        event_type: 'appointment_care_changed', metadata: { appointment_id: cita.id_cita, action: 'start' } }, raw: true });
      const frozen = op.metadata.documentation_snapshot;
      assert.equal(frozen.revisions.length, 12); assert.equal(frozen.draft_count, 1);
      assert.deepEqual(frozen.treatment_ids, [17]); assert.equal(frozen.treatment_name, 'Técnica ficticia sin requisitos');
      assert(!JSON.stringify(frozen).includes('Texto OWNED')); assert(!JSON.stringify(frozen).includes('BORRADOR'));
      assert.equal((await db.AppointmentCareEvent.findByPk(op.metadata.care_event_id)).action, 'start');
      const pages = [];
      for (let page = 0; page < 3; page++) pages.push(await docs.forAppointment({ clinicId: 100, appointmentId: cita.id_cita, query: { page } }));
      assert.deepEqual(pages.map(page => page.items.length), [5, 5, 2]);
      assert.deepEqual(pages.flatMap(page => page.items.map(item => item.id)), approved.map(item => item.id));
      assert(pages.every(page => page.persisted_for_appointment && page.context_source === 'appointment_start_snapshot'
        && page.total === 12 && page.snapshot_sha256 === frozen.sha256));
      check('Actual start freezes all 12 exact approved revisions, excludes draft/other clinic and returns pages 5/5/2 without clinical or financial side effects',
        { references: 12, page_sizes: [5, 5, 2], draft_count: 1, source: pages[0].context_source });

      const oldRevision = (await db.TreatmentProtocolRevision.findOne({ where: { protocol_id: approved[0].id, version: 1 }, raw: true })).snapshot;
      await docs.save({ clinicId: 100, actorId: 7, id: approved[0].id, payload: { expected_version: 1,
        content: 'NUEVO_BORRADOR_NO_CAMBIAR_CITA_INICIADA' } });
      await save([17], 20);
      await db.Tratamiento.update({ nombre: 'Nombre nuevo posterior', activo: false, eliminado_por_clinica: [100] }, { where: { id_tratamiento: 17 } });
      const afterEdit = await docs.forAppointment({ clinicId: 100, appointmentId: cita.id_cita });
      assert.equal(afterEdit.items[0].content, oldRevision.content); assert.equal(afterEdit.items[0].version, 1);
      assert.equal(afterEdit.treatment_name, frozen.treatment_name); assert.equal(afterEdit.total, 12); assert.equal(afterEdit.draft_count, 1);
      assert.equal(afterEdit.snapshot_sha256, frozen.sha256);
      assert.equal((await db.PatientOperationalEvent.findByPk(op.id)).metadata.documentation_snapshot.sha256, frozen.sha256);
      check('Editing an approved protocol into draft and hiding/renaming its treatment cannot rewrite the started visit or add a later protocol', { original_version: 1, total: 12 });
      await db.Tratamiento.update({ nombre: 'Técnica ficticia sin requisitos', activo: true, eliminado_por_clinica: [] }, { where: { id_tratamiento: 17 } });

      const replay = await f.start(cita); assert.equal(replay.replayed, true);
      assert.equal(await db.AppointmentCareEvent.count({ where: { appointment_id: cita.id_cita, action: 'start' } }), 1);
      const race = await f.appointment(17); await f.arrive(race);
      const racingStarts = await Promise.all([f.start(race), f.start(race)]);
      assert.equal(racingStarts.filter(result => !result.replayed).length, 1);
      assert.equal(await db.AppointmentCareEvent.count({ where: { appointment_id: race.id_cita, action: 'start' } }), 1);
      assert.equal(await db.PatientOperationalEvent.count({ where: { metadata: { appointment_id: race.id_cita, action: 'start' } } }), 1);
      check('Repeated/concurrent start produces exactly one pair of linked care/documentation events', { concurrent_winners: 1 });

      const corruptTarget = approved[1];
      const original = await db.TreatmentProtocolRevision.findOne({ where: { protocol_id: corruptTarget.id, version: 1 }, raw: true });
      await db.TreatmentProtocolRevision.destroy({ where: { id: original.id } });
      const missing = await docs.forAppointment({ clinicId: 100, appointmentId: cita.id_cita });
      assert.equal(missing.total, 12); assert.equal(missing.unavailable_count, 1); assert.equal(missing.items.length, 4);
      assert.equal(missing.snapshot_sha256, frozen.sha256);
      const denied = await f.appointment(17); await f.arrive(denied);
      await assert.rejects(f.start(denied), { code: 'appointment_documentation_revision_unavailable' });
      assert.equal((await db.CitaPaciente.findByPk(denied.id_cita)).care_started_at, null);
      assert.equal(await db.AppointmentCareEvent.count({ where: { appointment_id: denied.id_cita, action: 'start' } }), 0);
      await db.TreatmentProtocolRevision.create({ protocol_id: original.protocol_id, version: original.version, snapshot: original.snapshot, actor_id: 7 });
      check('Missing exact revision is explicit unavailable history and denies a new start without borrowing mutable text or leaving start events', { unavailable: 1 });

      const rollback = await f.appointment(17); await f.arrive(rollback);
      db.PatientOperationalEvent.addHook('beforeCreate', 'owned-documentation-start-failure', event => {
        if (event.metadata?.appointment_id === rollback.id_cita && event.metadata.action === 'start') throw Error('OWNED_DOCUMENTATION_EVENT_FAILURE');
      });
      await assert.rejects(f.start(rollback), error => error.message === 'OWNED_DOCUMENTATION_EVENT_FAILURE');
      db.PatientOperationalEvent.removeHook('beforeCreate', 'owned-documentation-start-failure');
      assert.equal((await db.CitaPaciente.findByPk(rollback.id_cita)).care_started_at, null);
      assert.equal(await db.AppointmentCareEvent.count({ where: { appointment_id: rollback.id_cita, action: 'start' } }), 0);
      check('Operational-event insertion failure rolls back appointment start, care event and frozen references in one transaction', { partial_started_rows: 0 });

      await assert.rejects(docs.forAppointment({ clinicId: 200, appointmentId: cita.id_cita }), { code: 'appointment_not_found' });
      await db.Paciente.update({ clinica_id: 200 }, { where: { id_paciente: 1 } });
      db.PacienteClinica = { findOne: async () => null }; // Ancillary link fixture only; no employee ACL is bypassed/claimed.
      await assert.rejects(docs.forAppointment({ clinicId: 100, appointmentId: cita.id_cita }), { code: 'appointment_not_found' });
      await db.Paciente.update({ clinica_id: 100 }, { where: { id_paciente: 1 } });
      check('Frozen document read still validates exact appointment clinic and current patient-clinic linkage before returning text', { patient_acl_endpoint_e2e: false });

      const legacy = await f.appointment(17); await f.arrive(legacy);
      await legacy.reload(); const legacyStart = new Date();
      await legacy.update({ care_started_at: legacyStart, care_started_by: 7 });
      const legacyRead = await docs.forAppointment({ clinicId: 100, appointmentId: legacy.id_cita });
      assert.equal(legacyRead.context_source, 'current_approved_catalog'); assert.equal(legacyRead.persisted_for_appointment, false);
      assert.equal((await f.start(legacy)).replayed, true);
      assert.equal(await db.PatientOperationalEvent.count({ where: { metadata: { appointment_id: legacy.id_cita, action: 'start' } } }), 0);
      const withoutTreatment = await f.appointment(null); await f.arrive(withoutTreatment); await f.start(withoutTreatment);
      const empty = await docs.forAppointment({ clinicId: 100, appointmentId: withoutTreatment.id_cita });
      assert.equal(empty.documentation_status, 'no_treatment'); assert.equal(empty.total, 0); assert.equal(empty.persisted_for_appointment, true);
      check('Legacy starts are never backfilled/reapproved; new no-treatment visits have an explicit empty start reference', { legacy_backfilled: false, no_treatment_references: 0 });

      // Own native voucher/session models prove purchased composition, without
      // reorganizing programs, using a balance or approving any real program.
      for (const file of ['patientvoucher', 'patientprogramsession']) {
        const model = require('../../../models/' + file)(context.sql, db.Sequelize.DataTypes); db[model.name] = model; await model.sync();
      }
      const voucher = await db.PatientVoucher.create({ public_id: 'owned-program-protocol-1', clinic_id: 100, patient_id: 1,
        treatment_id: 17, name: 'Programa ficticio comprado', total_units: 5, available_units: 3, sold_amount: 100,
        status: 'active', source_system: 'treatment_program' });
      const combined = await f.appointment(17, { voucher_id: voucher.id, source_system: 'treatment_program' });
      const purchasedSnapshot = { treatment_ids: [17, 12], phase_treatments: [{ key: 'first', treatment_id: 17 }, { key: 'second', treatment_id: 12 }] };
      const session = await db.PatientProgramSession.create({ voucher_id: voucher.id, appointment_id: combined.id_cita,
        session_key: 'second', position: 2, snapshot_sha256: digest(purchasedSnapshot), snapshot: purchasedSnapshot });
      await save([12], 21);
      const packageForCombined = await f.consents.createPackageForAppointment(combined.id_cita, { createdBy: 7 });
      for (const document of packageForCombined.documents) await f.consents.signConsentDocument(document.id, f.signature('owned-combined'));
      await f.arrive(combined); await f.start(combined);
      const combinedOp = await db.PatientOperationalEvent.findOne({ where: { metadata: { appointment_id: combined.id_cita, action: 'start' } }, raw: true });
      assert.deepEqual(combinedOp.metadata.documentation_snapshot.treatment_ids, [12, 17]);
      assert.equal(combinedOp.metadata.documentation_snapshot.revisions.length, 13);
      assert.equal(String((await db.PatientVoucher.findByPk(voucher.id)).available_units), '3.00');
      assert.deepEqual((await db.PatientProgramSession.findByPk(session.id)).snapshot, purchasedSnapshot);
      assert.equal((await db.PatientProgramSession.findByPk(session.id)).consumption_movement_id, null);
      check('Purchased session captures both explicit treatment protocol sets with actual consent/sign/start, without consuming units or changing session position/snapshot',
        { treatment_ids: [12, 17], protocol_references: 13, available_units: '3.00', source: 'native_purchased_session' });

      context.report.boundaries = { actual_care_and_documentation_services: true, native_protocol_revision_care_event_models: true,
        ancillary_clinic_patient_treatment_scaffolds: true, synthetic_approvals_only: true, external_sends: 0,
        production_data_touched: false, employee_endpoint_auth_e2e: false, rendered_ui_tested: false };
      context.report.checks.push('Actual native SQL clinical start captures immutable exact protocol references with transactional audit identity, current clinic/patient checks, no legacy backfill and purchased explicit composition');
    });
  });
