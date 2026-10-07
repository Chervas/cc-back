'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedConsentConsistencyFixture } = require('./helpers/owned-consent-consistency-fixture');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const assertStillBlocked = async promise => {
  const outcome = await Promise.race([promise.then(() => 'settled', () => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('waiting'), 40))]);
  assert.equal(outcome, 'waiting', 'concurrent native SQL mutation must wait for selected revision SHARE lock');
};

// Opt-in audit/regression: synthetic rows on an OWNED private SQL socket only.
// The unsafe pre-fix result is preserved in its separate private audit artifact;
// this regression records actual issuance, signature and care outcomes.
test('operational consent issuance uses published Spanish versions, never newer drafts/archives/foreign locales',
  { skip: process.env.CONSENT_VERSION_SELECTION_MYSQL_AUDIT !== '1', timeout: 180000 }, async () => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createOwnedConsentConsistencyFixture(context), { db, consents } = f;
      const violations = [], observations = context.report.observations = [];
      let serial = 0;
      const scenarios = [
        { key: 'clinic_newer_draft', source: 'clinic', newerStatus: 'draft', locale: 'es' },
        { key: 'catalog_newer_draft', source: 'catalog', newerStatus: 'draft', locale: 'es' },
        { key: 'clinic_newer_archived', source: 'clinic', newerStatus: 'archived', locale: 'es' },
        { key: 'clinic_newer_English_published', source: 'clinic', newerStatus: 'published', locale: 'en' },
        { key: 'clinic_only_draft', source: 'clinic', newerStatus: 'draft', locale: 'es', withoutSpanishPublication: true },
        { key: 'clinic_only_English_published', source: 'clinic', newerStatus: 'published', locale: 'en', withoutSpanishPublication: true },
      ];
      for (const scenario of scenarios) {
        const treatmentId = 110 + ++serial, templateId = 500 + serial;
        const publishedId = 1000 + serial * 10, newerId = publishedId + 1;
        await db.Tratamiento.create({ id_tratamiento: treatmentId, clinica_id: 100, nombre: 'Técnica ficticia ' + scenario.key,
          disciplina: 'Ficticia', origen: 'clinica', eliminado_por_clinica: [], activo: true, precio_base: 10 });
        const templateModel = scenario.source === 'clinic' ? db.ClinicConsentTemplate : db.ConsentTemplateCatalog;
        const versionModel = scenario.source === 'clinic' ? db.ClinicConsentTemplateVersion : db.ConsentTemplateCatalogVersion;
        const parentField = scenario.source === 'clinic' ? 'clinic_template_id' : 'catalog_id';
        await templateModel.create({ id: templateId, public_id: 'owned_version_template_' + serial,
          ...(scenario.source === 'clinic' ? { clinic_id: 100 } : {}), name: 'Documento ficticio ' + scenario.key,
          purpose: 'clinical', status: 'active', validity_mode: 'single_act', blocking_policy: 'hard' });
        const values = (id, version, status, locale) => ({ id, [parentField]: templateId, version, status, locale,
          title: 'Texto ficticio ' + scenario.key + ' ' + status + ' ' + locale,
          body_html: '<p>Contenido ficticio ' + scenario.key + ' ' + status + ' ' + locale + '.</p>',
          published_at: status === 'published' ? new Date() : null });
        if (!scenario.withoutSpanishPublication) await versionModel.create(values(publishedId, 1, 'published', 'es'));
        await versionModel.create(values(newerId, 2, scenario.newerStatus, scenario.locale));
        await db.TreatmentConsentRequirement.create({ tratamiento_id: treatmentId, clinica_id: 100,
          [scenario.source === 'clinic' ? 'clinic_template_id' : 'catalog_template_id']: templateId,
          required: true, blocking_policy: 'hard' });
        const cita = await f.appointment(treatmentId);
        const [prepared] = await Promise.allSettled([consents.createPackageForAppointment(cita.id_cita, { createdBy: 7 })]);
        if (prepared.status === 'rejected') {
          const noPartialPackage = await db.ConsentSignaturePackage.count({ where: { cita_id: cita.id_cita } }) === 0;
          const noPartialDocuments = await db.PatientConsentDocument.count({ where: { cita_id: cita.id_cita } }) === 0;
          const expected = scenario.withoutSpanishPublication && prepared.reason.message === 'consent_template_version_unavailable'
            && prepared.reason.statusCode === 409 && noPartialPackage && noPartialDocuments;
          observations.push({ scenario: scenario.key, selected: null, preparation_error: prepared.reason.message,
            no_partial_package: noPartialPackage, no_partial_documents: noPartialDocuments,
            meets_operational_policy: expected });
          if (!expected) violations.push(scenario.key);
          continue;
        }
        const doc = prepared.value.documents[0], versionId = scenario.source === 'clinic'
          ? doc.clinic_template_version_id : doc.catalog_template_version_id;
        const selected = await versionModel.findByPk(versionId);
        await f.arrive(cita);
        await assert.rejects(f.start(cita), error => error.code === 'appointment_consent_required');
        await consents.signConsentDocument(doc.id, f.signature(scenario.key));
        const [started] = await Promise.allSettled([f.start(cita)]);
        const expected = !scenario.withoutSpanishPublication && Number(versionId) === publishedId && selected.status === 'published'
          && selected.locale === 'es';
        observations.push({ scenario: scenario.key, selected: { id: Number(versionId), status: selected.status,
          locale: selected.locale, published_at: selected.published_at }, expected_version_id: scenario.withoutSpanishPublication ? null : publishedId,
          patient_signature_accepted: true, clinical_start_after_signature: started.status,
          clinical_start_error: started.reason?.code || null, snapshot_contains_publication_status: Object.hasOwn(doc.snapshot_json.version, 'status'),
          meets_operational_policy: expected });
        if (!expected) violations.push(scenario.key);
      }

      // A future draft must not invalidate or replace evidence already frozen
      // for the same act. This is a preservation regression, not an approval of
      // a draft or retrospective requirement to re-sign an existing document.
      const historic = await f.prepare(12);
      await consents.signConsentDocument(historic.doc.id, f.signature('published_before_future_draft'));
      const frozen = (await db.PatientConsentDocument.findByPk(historic.doc.id)).toJSON();
      await db.ClinicConsentTemplateVersion.create({ id: 1900, clinic_template_id: 102, version: 9, locale: 'es',
        title: 'Borrador ficticio posterior', body_html: '<p>Nuevo borrador, no emitido.</p>', status: 'draft', published_at: null });
      const refreshed = await consents.createPackageForAppointment(historic.cita.id_cita, { createdBy: 7 });
      const retained = refreshed.documents.find(doc => Number(doc.id) === Number(historic.doc.id));
      assert(retained); assert.equal(retained.status, 'signed'); assert.equal(retained.snapshot_hash, frozen.snapshot_hash);
      assert.deepEqual(retained.snapshot_json, frozen.snapshot_json);
      assert.equal(retained.clinic_template_version_id, 202);
      await f.arrive(historic.cita); await f.start(historic.cita);
      observations.push({ scenario: 'existing_published_signature_preserved_after_new_draft', passed: true });

      // No new published version is required when the same act already owns a
      // live document (pending or signed), or a manual signed notice is reused.
      for (const signed of [false, true]) {
        const sameAct = await f.prepare(11);
        if (signed) await consents.signConsentDocument(sameAct.doc.id, f.signature('same-act-retained'));
        const original = (await db.PatientConsentDocument.findByPk(sameAct.doc.id)).toJSON();
        await db.ClinicConsentTemplateVersion.update({ status: 'archived' }, { where: { clinic_template_id: 101 } });
        const result = await consents.createPackageForAppointment(sameAct.cita.id_cita, { createdBy: 7 });
        const kept = result.documents.find(row => Number(row.id) === Number(original.id));
        assert(kept); assert.equal(kept.snapshot_hash, original.snapshot_hash); assert.deepEqual(kept.snapshot_json, original.snapshot_json);
        assert.equal(kept.status, original.status); assert.equal(result.documents.length, 1);
        await db.ClinicConsentTemplateVersion.update({ status: 'published' }, { where: { id: 201 } });
        observations.push({ scenario: 'same_act_' + (signed ? 'signed' : 'pending') + '_retained_without_current_publication', passed: true });
      }
      const reusable = await f.prepare(15);
      await consents.signConsentDocument(reusable.doc.id, f.signature('manual-retained'));
      const originalReusable = (await db.PatientConsentDocument.findByPk(reusable.doc.id)).toJSON();
      await db.ClinicConsentTemplateVersion.update({ status: 'archived' }, { where: { clinic_template_id: 104 } });
      const totalBeforeReuse = await db.PatientConsentDocument.count();
      const secondAct = await f.appointment(16);
      await consents.createPackageForAppointment(secondAct.id_cita, { createdBy: 7 });
      assert.equal(await db.PatientConsentDocument.count(), totalBeforeReuse);
      const keptReusable = (await db.PatientConsentDocument.findByPk(reusable.doc.id)).toJSON();
      assert.equal(keptReusable.snapshot_hash, originalReusable.snapshot_hash);
      assert.deepEqual(keptReusable.snapshot_json, originalReusable.snapshot_json);
      observations.push({ scenario: 'manual_signed_reusable_retained_without_current_publication', passed: true });

      // A later required template without a published Spanish version rolls
      // back a document already inserted for an earlier, available template.
      await db.TreatmentConsentRequirement.create({ tratamiento_id: 111, clinica_id: 100, clinic_template_id: 505,
        required: true, blocking_policy: 'hard', sort_order: 1 });
      const mixed = await f.appointment(111); let attemptedDocuments = 0;
      db.PatientConsentDocument.addHook('afterCreate', 'owned-version-atomic', (doc, options) => {
        if (Number(doc.cita_id) === Number(mixed.id_cita) && options.transaction) attemptedDocuments++;
      });
      await assert.rejects(consents.createPackageForAppointment(mixed.id_cita, { createdBy: 7 }),
        error => error.message === 'consent_template_version_unavailable' && error.statusCode === 409);
      db.PatientConsentDocument.removeHook('afterCreate', 'owned-version-atomic');
      assert.equal(attemptedDocuments, 1);
      assert.equal(await db.ConsentSignaturePackage.count({ where: { cita_id: mixed.id_cita } }), 0);
      assert.equal(await db.PatientConsentDocument.count({ where: { cita_id: mixed.id_cita } }), 0);
      observations.push({ scenario: 'second_missing_publication_rolls_back_first_document_and_package', passed: true });

      // Pause AFTER the real operational SELECT, but BEFORE document INSERT
      // (whose FK would otherwise hide a missing explicit SELECT lock). A
      // caller-owned transaction retains that exact revision through either
      // commit or rollback. No template/publication-set serialization is
      // asserted: another revision remains a separate concurrent operation.
      for (const source of ['clinic', 'catalog']) for (const operation of ['update', 'delete']) {
        for (const ending of ['commit', 'rollback']) {
          const number = ++serial, treatmentId = 130 + number, templateId = 600 + number, versionId = 3000 + number;
          const templateModel = source === 'clinic' ? db.ClinicConsentTemplate : db.ConsentTemplateCatalog;
          const versionModel = source === 'clinic' ? db.ClinicConsentTemplateVersion : db.ConsentTemplateCatalogVersion;
          const parentField = source === 'clinic' ? 'clinic_template_id' : 'catalog_id';
          await db.Tratamiento.create({ id_tratamiento: treatmentId, clinica_id: 100, nombre: 'Técnica ficticia de bloqueo ' + number,
            disciplina: 'Ficticia', origen: 'clinica', eliminado_por_clinica: [], activo: true, precio_base: 10 });
          await templateModel.create({ id: templateId, public_id: 'owned_locked_revision_template_' + number,
            ...(source === 'clinic' ? { clinic_id: 100 } : {}), name: 'Documento ficticio de bloqueo ' + number,
            purpose: 'clinical', status: 'active', validity_mode: 'single_act', blocking_policy: 'hard' });
          await versionModel.create({ id: versionId, [parentField]: templateId, version: 1, status: 'published', locale: 'es',
            title: 'Revisión ficticia congelada ' + number, body_html: '<p>Contenido ficticio retenido ' + number + '.</p>',
            published_at: new Date() });
          await db.TreatmentConsentRequirement.create({ tratamiento_id: treatmentId, clinica_id: 100,
            [source === 'clinic' ? 'clinic_template_id' : 'catalog_template_id']: templateId,
            required: true, blocking_policy: 'hard' });
          const cita = await f.appointment(treatmentId), selected = deferred(), proceed = deferred(); let paused = false;
          const tx = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' });
          const hook = 'owned-operational-revision-share-' + number;
          versionModel.addHook('afterFind', hook, async (row, options) => {
            if (paused || options.transaction !== tx || Number(options.where?.[parentField]) !== templateId) return;
            assert.equal(Number(row.id), versionId); assert.equal(options.lock, tx.LOCK.SHARE);
            paused = true; selected.resolve(); await proceed.promise;
          });
          let mutation, preparation;
          try {
            preparation = consents.createPackageForAppointment(cita.id_cita, { createdBy: 7 }, tx);
            const preparationDone = Promise.allSettled([preparation]);
            await Promise.race([selected.promise, preparationDone]);
            assert(paused, 'operational selection must reach the native revision hook');
            mutation = operation === 'update'
              ? versionModel.update({ status: 'archived', title: 'Cambio concurrente ficticio ' + number }, { where: { id: versionId } })
              : versionModel.destroy({ where: { id: versionId } });
            const mutationDone = Promise.allSettled([mutation]);
            await assertStillBlocked(mutation);
            proceed.resolve();
            const [prepared] = await preparationDone; assert.equal(prepared.status, 'fulfilled');
            const document = prepared.value.documents[0].toJSON(), frozenVersion = document.snapshot_json.version;
            assert.equal(frozenVersion.id, versionId); assert.equal(frozenVersion.title, 'Revisión ficticia congelada ' + number);
            await assertStillBlocked(mutation);
            await tx[ending]();
            const [changed] = await mutationDone; assert.equal(changed.status, 'fulfilled');
            assert.equal(await db.PatientConsentDocument.count({ where: { cita_id: cita.id_cita } }), ending === 'commit' ? 1 : 0);
            assert.equal(await db.ConsentSignaturePackage.count({ where: { cita_id: cita.id_cita } }), ending === 'commit' ? 1 : 0);
            if (ending === 'commit') {
              const retained = await db.PatientConsentDocument.findByPk(document.id);
              assert.equal(retained.snapshot_hash, document.snapshot_hash);
              assert.deepEqual(retained.snapshot_json, document.snapshot_json);
            }
            const revision = await versionModel.findByPk(versionId);
            assert(operation === 'delete' ? revision === null : revision.status === 'archived');
            observations.push({ scenario: `${source}_revision_${operation}_waits_for_issuance_${ending}`, passed: true,
              blocked_before_document_insert: true, snapshot_retained: ending === 'commit', rolled_back_without_documents: ending === 'rollback' });
          } finally {
            proceed.resolve(); versionModel.removeHook('afterFind', hook);
            if (!tx.finished) await tx.rollback();
            if (preparation) await Promise.allSettled([preparation]);
            if (mutation) await Promise.allSettled([mutation]);
          }
        }
      }
      context.report.boundaries = { real_services_and_native_sql: true, employee_http_auth_e2e: false,
        external_sends: 0, production_data_touched: false, new_issuance_policy: 'published_es_only', clinical_approval_created: false,
        protocol_coverage_proved: false, selected_revision_locked_until_commit_or_rollback: true,
        publication_of_new_revision_or_template_status_serialized: false };
      context.report.checks.push('Actual operational version selection and signature/care outcome characterized; historical signed evidence is retained unchanged');
      assert.deepEqual(violations, [], 'Unsafe operational selection reproduced: ' + JSON.stringify(observations));
    });
  });
