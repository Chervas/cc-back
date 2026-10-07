'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedDocumentationComponentFixture } = require('./helpers/owned-documentation-component-fixture');
const { createTreatmentDocumentationService } = require('../../services/treatmentDocumentation.service');
const { digest } = require('../../lib/appointment-documentation-snapshot');

test('real PRP component relation freezes parent protocols only after both actual signatures on OWNED SQL',
  { skip: process.env.APPOINTMENT_DOCUMENTATION_COMPONENT_MYSQL_TEST !== '1', timeout: 180000 }, async () => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createOwnedDocumentationComponentFixture(context), { db } = f;
      const docs = createTreatmentDocumentationService(db), observations = context.report.observations = [];
      const record = (name, actual) => observations.push({ name, passed: true, actual });
      // These synthetic approvals exercise the real service/version tables;
      // they are not approvals of the clinic's actual documents.
      const save = async (ids, index, status = 'approved') => (await docs.save({ clinicId: 66, actorId: 50,
        payload: { title: 'Documento OWNED ficticio ' + index, content: 'Texto OWNED ficticio ' + index,
          source: 'Sólo fixture OWNED ' + index, kind: index === 2 ? 'aftercare' : 'protocol', status,
          treatment_ids: ids } })).item;
      const parentProtocols = [await save([688], 1), await save([688], 2)];
      await save([688], 3, 'draft');
      const oldImProtocol = await save([1688], 4);

      const rows = await f.pair(), beforeLink = await f.physicalSnapshot(rows);
      const pkg = await f.prepareParent(rows); assert.equal(pkg.documents.length, 1);
      const unsignedParentDocument = (await db.PatientConsentDocument.findByPk(pkg.documents[0].id)).toJSON();
      const linked = await f.link(rows); assert.equal(linked.relation.status, 'linked'); assert.equal(linked.replayed, false);
      const afterLink = await f.physicalSnapshot(rows);
      for (let index = 0; index < 2; index++) {
        assert(f.componentService.unchangedAppointment(beforeLink.appointments[index], afterLink.appointments[index]));
        assert.equal(afterLink.appointments[index].import_metadata.cliniccloud_delta.source.price, '120.00');
      }
      assert.deepEqual(afterLink.occupancy, beforeLink.occupancy); assert.deepEqual(afterLink.anchors, beforeLink.anchors);
      assert.deepEqual((await db.PatientConsentDocument.findByPk(pkg.documents[0].id)).toJSON(), unsignedParentDocument);
      const parent = await f.validatedParent(rows.child);
      assert.equal(parent.parent.id_cita, rows.parent.id_cita);
      assert(f.components.isValidatedClinicalComponentContext(parent.context, parent.component));
      assert.equal(await db.PatientOperationalEvent.count({ where: { event_type: f.components.EVENT_TYPE } }), 1);
      record('Real link + reciprocal source receipts + native audit/occupancy/resource anchors validate one parent without changing either source price, schedule, state or pending parent document',
        { parent_treatment: 688, child_treatment: null, source_prices: ['120.00', '120.00'], overlap_minutes: 15 });

      await f.arrive(rows.child);
      await assert.rejects(f.start(rows.child), { code: 'appointment_consent_required' });
      assert.equal((await db.CitaPaciente.findByPk(rows.child.id_cita)).care_started_at, null);
      await f.consents.signConsentDocument(pkg.documents[0].id, f.signature('OWNED-PRP-PATIENT-ONLY'));
      await assert.rejects(f.start(rows.child), { code: 'appointment_consent_required' });
      await f.consents.signProfessionalConsentDocument(pkg.documents[0].id, { accepted_statement: true }, 50);
      const signed = (await db.PatientConsentDocument.findByPk(pkg.documents[0].id)).toJSON();
      assert(signed.signed_at); assert(signed.professional_signed_at); assert.equal(signed.professional_signed_by, 50);
      assert.equal(await db.PatientConsentDocument.count({ where: { cita_id: rows.child.id_cita } }), 0);
      record('Actual parent hard requirement rejects missing and patient-only signatures; real professional countersignature authorizes the child without issuing child consent or inferring a signature',
        { required_patient_and_professional: true, child_documents: 0 });

      // Assert capture and event inserts share the actual care transaction.
      const captureTransactions = [];
      db.TreatmentProtocolRevision.addHook('beforeFind', 'owned-component-capture-tx', options => {
        if (options.lock && options.transaction) captureTransactions.push(options.transaction.id);
      });
      db.AppointmentCareEvent.addHook('beforeCreate', 'owned-component-start-tx', (event, options) => {
        if (event.appointment_id === rows.child.id_cita && event.action === 'start') {
          assert(captureTransactions.length); assert(captureTransactions.every(id => id === options.transaction.id));
        }
      });
      const beforeStart = await f.physicalSnapshot(rows);
      assert.equal((await f.start(rows.child)).replayed, false);
      db.TreatmentProtocolRevision.removeHook('beforeFind', 'owned-component-capture-tx');
      db.AppointmentCareEvent.removeHook('beforeCreate', 'owned-component-start-tx');
      const afterStart = await f.physicalSnapshot(rows);
      const operation = await db.PatientOperationalEvent.findOne({ where: { patient_id: 8, clinic_id: 66,
        event_type: 'appointment_care_changed', source: 'agenda', metadata: { appointment_id: rows.child.id_cita, action: 'start' } }, raw: true });
      const frozen = operation.metadata.documentation_snapshot;
      assert.deepEqual(frozen.treatment_ids, [688]); assert.equal(frozen.treatment_id, 688);
      assert.equal(frozen.appointment_id, rows.child.id_cita); assert.equal(frozen.clinical_appointment_id, rows.parent.id_cita);
      assert.equal(frozen.clinical_context_source, 'validated_clinical_component_parent');
      const receipt = afterLink.appointments[0].import_metadata.clinical_component_parent;
      assert.equal(frozen.clinical_relation_audit_event_id, String(receipt.audit_event_id));
      assert.equal(frozen.clinical_relation_receipt_sha256, receipt.receipt_sha256);
      assert.deepEqual(frozen.revisions.map(ref => ref.id), parentProtocols.map(item => item.id));
      assert(!frozen.revisions.some(ref => ref.id === oldImProtocol.id)); assert.equal(frozen.draft_count, 1);
      assert(!JSON.stringify(frozen).includes('Texto OWNED'));
      assert.deepEqual(afterStart.appointments[1], beforeStart.appointments[1]);
      for (const key of ['inicio', 'fin', 'estado', 'doctor_id', 'instalacion_id', 'tratamiento_id', 'voucher_id', 'import_metadata', 'nota']) {
        assert.deepEqual(afterStart.appointments[0][key], beforeStart.appointments[0][key], key);
      }
      assert.equal(afterStart.appointments[0].tratamiento_id, null);
      assert.deepEqual(afterStart.occupancy, beforeStart.occupancy); assert.deepEqual(afterStart.anchors, beforeStart.anchors);
      assert.equal(await db.PatientVoucherMovement.count(), 0); assert.equal(await db.PatientProgramSession.count(), 0);
      const page = await docs.forAppointment({ clinicId: 66, appointmentId: rows.child.id_cita });
      assert.equal(page.persisted_for_appointment, true); assert.equal(page.context_source, 'appointment_start_snapshot');
      assert.equal(page.treatment_id, 688); assert.equal(page.snapshot_sha256, frozen.sha256);
      assert.deepEqual(page.items.map(item => item.id), parentProtocols.map(item => item.id));
      record('Real care start freezes BOTH exact parent protocol versions under the same transaction, sealed to child care event + validated parent audit/receipt; own null/IM/draft are not a clinical treatment',
        { treatment_ids: frozen.treatment_ids, references: frozen.revisions.length, child_id: frozen.appointment_id,
          parent_id: frozen.clinical_appointment_id, capture_transactions: new Set(captureTransactions).size });

      await docs.save({ clinicId: 66, actorId: 50, id: parentProtocols[0].id,
        payload: { expected_version: 1, content: 'NUEVO BORRADOR OWNED posterior' } });
      const history = await docs.forAppointment({ clinicId: 66, appointmentId: rows.child.id_cita });
      assert.equal(history.items[0].version, 1); assert.equal(history.items[0].content, 'Texto OWNED ficticio 1');
      assert.equal(history.snapshot_sha256, frozen.sha256);
      assert.equal((await f.start(rows.child)).replayed, true);
      assert.equal(await db.AppointmentCareEvent.count({ where: { appointment_id: rows.child.id_cita, action: 'start' } }), 1);
      assert.equal((await db.PatientOperationalEvent.findByPk(operation.id)).metadata.documentation_snapshot.sha256, frozen.sha256);
      record('Later live-parent protocol edit and start replay cannot rewrite the child start references or add a second start', { exact_version: 1, replayed: true });

      const invalid = await f.pair(); await f.link(invalid);
      const invalidPkg = await f.prepareParent(invalid); await f.signParent(invalidPkg); await f.arrive(invalid.child);
      await invalid.parent.reload();
      await invalid.parent.update({ import_metadata: { ...invalid.parent.import_metadata, clinical_component_children: [] } });
      const invalidBefore = await f.physicalSnapshot(invalid);
      await assert.rejects(f.validatedParent(invalid.child), { code: 'appointment_clinical_component_relation_unproven' });
      await assert.rejects(f.start(invalid.child), { code: 'appointment_clinical_component_relation_unproven' });
      assert.deepEqual(await f.physicalSnapshot(invalid), invalidBefore);
      assert.equal(await db.AppointmentCareEvent.count({ where: { appointment_id: invalid.child.id_cita, action: 'start' } }), 0);
      record('Broken reciprocal relation is rejected by the real clinical verifier even with BOTH parent signatures; no schedule/state/price/occupancy mutation or start remains', { start_events: 0 });

      const oldIm = await f.pair({ childTreatmentId: 1688 }), oldImBefore = await f.physicalSnapshot(oldIm);
      const auditsBeforeIm = await db.PatientOperationalEvent.count({ where: { event_type: f.components.EVENT_TYPE } });
      await assert.rejects(f.link(oldIm), { code: 'appointment_clinical_component_roles_unproven' });
      assert.deepEqual(await f.physicalSnapshot(oldIm), oldImBefore);
      assert.equal(await db.PatientOperationalEvent.count({ where: { event_type: f.components.EVENT_TYPE } }), auditsBeforeIm);
      record('An old IM-assigned child cannot be reinterpreted as a validated PRP extraction; exact role guard rejects it without unassigning treatment or inventing a relation',
        { old_treatment_id: 1688, relation_created: false });

      const rollback = await f.pair(); await f.link(rollback);
      await f.signParent(await f.prepareParent(rollback)); await f.arrive(rollback.child);
      const rollbackBefore = await f.physicalSnapshot(rollback);
      const signedDocumentsBefore = await db.PatientConsentDocument.findAll({
        where: { cita_id: rollback.parent.id_cita }, order: [['id', 'ASC']], raw: true });
      db.PatientOperationalEvent.addHook('beforeCreate', 'owned-component-documentation-rollback', event => {
        if (event.event_type === 'appointment_care_changed' && event.metadata?.appointment_id === rollback.child.id_cita
          && event.metadata.action === 'start') throw Error('OWNED_COMPONENT_START_EVENT_FAILURE');
      });
      await assert.rejects(f.start(rollback.child), error => error.message === 'OWNED_COMPONENT_START_EVENT_FAILURE');
      db.PatientOperationalEvent.removeHook('beforeCreate', 'owned-component-documentation-rollback');
      assert.deepEqual(await f.physicalSnapshot(rollback), rollbackBefore);
      assert.equal(await db.AppointmentCareEvent.count({ where: { appointment_id: rollback.child.id_cita, action: 'start' } }), 0);
      assert.equal(await db.PatientOperationalEvent.count({ where: { metadata: { appointment_id: rollback.child.id_cita, action: 'start' } } }), 0);
      assert.deepEqual(await db.PatientConsentDocument.findAll({ where: { cita_id: rollback.parent.id_cita },
        order: [['id', 'ASC']], raw: true }), signedDocumentsBefore);
      assert.equal(await db.PatientVoucherMovement.count(), 0); assert.equal(await db.PatientProgramSession.count(), 0);
      record('Failure after parent-reference capture rolls back child care timestamp + care/operational events; existing relation, signed parent documents and physical reservations survive literally',
        { partial_start_events: 0 });

      context.report.boundaries = { actual_component_verifier_not_overridden: true, actual_link_and_care_services: true,
        actual_consent_signatures: true, native_audit_cita_occupancy_resource_models: true,
        ancillary_patient_clinic_treatment_scaffolds: true, synthetic_feature_permissions_and_physical_alias_resolution: true,
        employee_endpoint_acl_e2e: false, clinical_treatment_approvals: 'synthetic OWNED only',
        real_patient_or_catalogue_rows: false, runtime_activation: false, external_sends: 0 };
      context.report.checks_sha256 = digest({ relation_schema: f.components.SCHEMA_VERSION, observations: observations.map(row => row.name) });
      context.report.checks.push('Actual PRP child null relation + dual signed parent consent captures exact parent 688 protocol references atomically; invalid/old IM relations and failed audit leave physical/economic source intact');
    });
  });
