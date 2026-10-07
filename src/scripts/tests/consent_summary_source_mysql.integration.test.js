'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedConsentConsistencyFixture } = require('./helpers/owned-consent-consistency-fixture');

test('appointment consent summary uses frozen document title/timing, with published Spanish proposals only before issuance',
  { skip: process.env.CONSENT_SUMMARY_SOURCE_MYSQL_TEST !== '1', timeout: 180000 }, async () => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createOwnedConsentConsistencyFixture(context), { db, consents } = f;
      const observations = context.report.observations = [], violations = [];
      await db.ClinicConsentTemplateVersion.update({ variable_schema: { signing_timing: 'manual' } }, { where: { id: 202 } });
      await db.ClinicConsentTemplateVersion.create({ id: 1902, clinic_template_id: 102, version: 2, locale: 'es',
        title: 'BORRADOR ficticio que no debe mostrarse como emitido', body_html: '<p>Borrador no emitido.</p>',
        variable_schema: { signing_timing: 'at_least_24h_before' }, status: 'draft', published_at: null });
      const appointment = await f.appointment(12);
      const proposal = await consents.getConsentSummaryForAppointment(appointment);
      const proposalCorrect = proposal.due_policy === 'manual' && proposal.pending_document_titles[0].title === 'Versión ficticia 102';
      observations.push({ scenario: 'unissued_proposal_uses_published_es', passed: proposalCorrect,
        actual_title: proposal.pending_document_titles[0].title, actual_due_policy: proposal.due_policy });
      if (!proposalCorrect) violations.push('unissued_proposal');
      const pkg = await consents.createPackageForAppointment(appointment.id_cita);
      const document = pkg.documents[0], frozen = (await db.PatientConsentDocument.findByPk(document.id)).toJSON();
      await db.ClinicConsentTemplateVersion.update({ title: 'Título de catálogo mutable posterior',
        variable_schema: { signing_timing: 'first_visit' } }, { where: { id: 202 } });
      const current = await consents.getConsentSummaryForAppointment(appointment);
      const snapshotCorrect = current.due_policy === frozen.snapshot_json.clinical_policy.due_policy
        && current.pending_document_titles[0].title === frozen.snapshot_json.version.title
        && current.pending_document_titles[0].document_id === document.id && current.pending_document_titles[0].pending_party === 'patient';
      observations.push({ scenario: 'pending_issued_title_and_timing_are_frozen', passed: snapshotCorrect,
        actual_title: current.pending_document_titles[0].title, actual_due_policy: current.due_policy });
      if (!snapshotCorrect) violations.push('pending_snapshot');
      assert.equal(current.pending_required, 1); assert.equal(current.has_pending, true);
      await f.arrive(appointment); await assert.rejects(f.start(appointment), error => error.code === 'appointment_consent_required');
      const unchanged = (await db.PatientConsentDocument.findByPk(document.id)).toJSON();
      assert.equal(unchanged.snapshot_hash, frozen.snapshot_hash); assert.deepEqual(unchanged.snapshot_json, frozen.snapshot_json);
      assert.equal(unchanged.status, 'pending'); assert.equal(unchanged.signed_at, null);

      await db.ClinicConsentTemplateVersion.update({ variable_schema: { signing_timing: 'at_treatment' } }, { where: { id: 201 } });
      const professional = await f.prepare(11);
      await consents.signConsentDocument(professional.doc.id, f.signature('summary-only-professional'));
      const signed = (await db.PatientConsentDocument.findByPk(professional.doc.id)).toJSON();
      await db.ClinicConsentTemplateVersion.create({ id: 1901, clinic_template_id: 101, version: 2, locale: 'es',
        title: 'BORRADOR distinto al documento por contrafirmar', body_html: '<p>Borrador no emitido.</p>',
        variable_schema: { signing_timing: 'at_least_24h_before' }, status: 'draft', published_at: null });
      const pendingProfessional = await consents.getConsentSummaryForAppointment(professional.cita);
      const professionalCorrect = pendingProfessional.due_policy === signed.snapshot_json.clinical_policy.due_policy
        && pendingProfessional.pending_document_titles[0].title === signed.snapshot_json.version.title
        && pendingProfessional.pending_document_titles[0].pending_party === 'professional';
      observations.push({ scenario: 'professional_countersign_summary_keeps_patient_document_source', passed: professionalCorrect,
        actual_title: pendingProfessional.pending_document_titles[0].title, actual_due_policy: pendingProfessional.due_policy,
        pending_party: pendingProfessional.pending_document_titles[0].pending_party });
      if (!professionalCorrect) violations.push('professional_snapshot');
      assert.equal((await db.PatientConsentDocument.findByPk(professional.doc.id)).snapshot_hash, signed.snapshot_hash);

      await db.Tratamiento.create({ id_tratamiento: 211, clinica_id: 100, nombre: 'Técnica ficticia pendiente publicación',
        disciplina: 'Ficticia', origen: 'clinica', eliminado_por_clinica: [], activo: true, precio_base: 10 });
      await db.ClinicConsentTemplate.create({ id: 777, public_id: 'owned_summary_draft_only', clinic_id: 100,
        name: 'Documento pendiente de publicar', purpose: 'clinical', status: 'active', blocking_policy: 'hard' });
      await db.ClinicConsentTemplateVersion.create({ id: 1777, clinic_template_id: 777, version: 1, locale: 'es',
        title: 'TÍTULO borrador no propuesto', body_html: '<p>Borrador no emitido.</p>', status: 'draft', published_at: null });
      await db.TreatmentConsentRequirement.create({ tratamiento_id: 211, clinica_id: 100, clinic_template_id: 777,
        required: true, blocking_policy: 'hard' });
      const draftAppointment = await f.appointment(211), draftSummary = await consents.getConsentSummaryForAppointment(draftAppointment);
      const draftCorrect = draftSummary.pending_document_titles[0].title === 'Documento pendiente de publicar';
      observations.push({ scenario: 'draft_only_summary_remains_pending_without_serving_draft_or_throwing', passed: draftCorrect,
        actual_title: draftSummary.pending_document_titles[0].title });
      if (!draftCorrect) violations.push('draft_only_summary');
      assert.equal(draftSummary.status, 'pending'); assert.equal(draftSummary.required_total, 1); assert.equal(draftSummary.blocking_pending, 1);
      assert.equal(await db.ConsentSignaturePackage.count({ where: { cita_id: draftAppointment.id_cita } }), 0);
      assert.equal(await db.PatientConsentDocument.count({ where: { cita_id: draftAppointment.id_cita } }), 0);
      context.report.boundaries = { native_sql_and_services: true, external_sends: 0, production_data_touched: false,
        employee_endpoint_auth_e2e: false, summary_calls_mutate_signature_or_authorization: false, clinical_approval_created: false };
      context.report.checks.push('Summary title/timing proposal and issued frozen evidence remain distinct; draft-only summary does not throw or authorize care');
      assert.deepEqual(violations, [], 'Wrong summary source reproduced: ' + JSON.stringify(observations));
    });
  });
