'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedConsentConsistencyFixture } = require('./helpers/owned-consent-consistency-fixture');

test('catalog synchronization/propagation preserve source draft status instead of promoting copied text to published',
  { skip: process.env.CONSENT_VERSION_COPY_MYSQL_TEST !== '1', timeout: 180000 }, async () => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createOwnedConsentConsistencyFixture(context), { db, consents } = f;
      // Native extra catalog tables needed by actual sync/copy consumers, not a
      // mocked clinical association or a change to the shared consent fixture.
      for (const file of ['consenttemplatecatalogdiscipline', 'consenttemplatecatalogtreatment']) {
        const model = require('../../../models/' + file)(context.sql, S.DataTypes); db[model.name] = model;
      }
      db.ConsentTemplateCatalog.hasMany(db.ConsentTemplateCatalogDiscipline, { foreignKey: 'catalog_id', as: 'disciplines' });
      db.ConsentTemplateCatalog.hasMany(db.ConsentTemplateCatalogTreatment, { foreignKey: 'catalog_id', as: 'treatments' });
      db.ConsentTemplateCatalogTreatment.associate(db);
      await context.sql.sync();
      // Production include lists request these real treatment columns even
      // with no linked base treatment; no service or query is replaced here.
      for (const column of ['codigo', 'especialidad', 'categoria', 'id_tratamiento_base']) {
        await context.sql.getQueryInterface().addColumn('Tratamientos', column,
          { type: column === 'id_tratamiento_base' ? S.DataTypes.INTEGER : S.DataTypes.STRING, allowNull: true });
      }
      const observations = context.report.observations = [], violations = [];
      let sequence = 0;
      const seedCatalog = async suffix => {
        const id = 800 + ++sequence;
        await db.ConsentTemplateCatalog.create({ id, public_id: 'owned_copy_catalog_' + suffix,
          catalog_key: 'owned-copy-' + suffix, name: 'Documento catálogo ficticio ' + suffix, is_generic: true,
          purpose: 'clinical', status: 'active', validity_mode: 'single_act', blocking_policy: 'hard' });
        await db.ConsentTemplateCatalogVersion.bulkCreate([
          { id: id * 10 + 1, catalog_id: id, version: 1, locale: 'es', title: 'Publicado anterior ' + suffix,
            body_html: '<p>Texto publicado ficticio anterior ' + suffix + '.</p>', status: 'published', published_at: new Date() },
          { id: id * 10 + 2, catalog_id: id, version: 2, locale: 'es', title: 'Borrador no publicado ' + suffix,
            body_html: '<p>Texto borrador ficticio ' + suffix + '.</p>', status: 'draft', published_at: null },
        ]);
        return id;
      };
      const checkCopied = async (catalogId, clinicId, label) => {
        const template = await db.ClinicConsentTemplate.findOne({ where: { source_catalog_id: catalogId, clinic_id: clinicId } });
        assert(template); assert.equal(template.status, 'active', 'Version state is separate from template activation');
        const copy = await db.ClinicConsentTemplateVersion.findOne({ where: { clinic_template_id: template.id } });
        const preserved = copy.status === 'draft' && copy.locale === 'es' && copy.published_at === null
          && Number(copy.source_catalog_version_id) === catalogId * 10 + 2;
        assert.match(copy.body_html, /Texto borrador ficticio/);
        const cita = await f.appointment(12, { clinica_id: clinicId, paciente_id: clinicId === 200 ? 2 : 1 });
        await db.TreatmentConsentRequirement.create({ tratamiento_id: 12, clinica_id: clinicId,
          clinic_template_id: template.id, required: true, blocking_policy: 'hard', sort_order: 2 });
        const [issuance] = await Promise.allSettled([consents.createPackageForAppointment(cita.id_cita, { createdBy: 7 })]);
        const noIssuance = issuance.status === 'rejected' && issuance.reason.message === 'consent_template_version_unavailable'
          && issuance.reason.statusCode === 409 && await db.ConsentSignaturePackage.count({ where: { cita_id: cita.id_cita } }) === 0
          && await db.PatientConsentDocument.count({ where: { cita_id: cita.id_cita } }) === 0;
        observations.push({ scenario: label, source_status: 'draft', copied_status: copy.status, copied_locale: copy.locale,
          copied_published_at: copy.published_at, source_version_id_preserved: Number(copy.source_catalog_version_id) === catalogId * 10 + 2,
          issuance_outcome: issuance.status, issuance_error: issuance.reason?.message,
          no_partial_package_or_document: noIssuance, source_status_preserved: preserved });
        if (!preserved || !noIssuance) violations.push(label);
      };
      const syncId = await seedCatalog('sync');
      const synced = await consents.syncClinicTemplatesFromCatalog(100, 7);
      assert.equal(synced.created_count, 1);
      await checkCopied(syncId, 100, 'sync_catalog_draft_to_active_clinic_template');
      const propagateId = await seedCatalog('propagate');
      const propagated = await consents.propagateAdminTemplateToClinics(propagateId, { clinic_ids: [200], userId: 7 });
      assert.equal(propagated.created_count, 1);
      await checkCopied(propagateId, 200, 'propagate_catalog_draft_to_active_clinic_template');

      const sourceDate = new Date('2025-03-04T10:11:12Z');
      await db.ConsentTemplateCatalog.create({ id: 850, public_id: 'owned_copy_published', catalog_key: 'owned-copy-published',
        name: 'Publicado ficticio preservado', is_generic: true, purpose: 'clinical', status: 'active',
        validity_mode: 'single_act', blocking_policy: 'hard' });
      await db.ConsentTemplateCatalogVersion.create({ id: 8501, catalog_id: 850, version: 1, locale: 'es',
        title: 'Texto publicado ficticio', body_html: '<p>Texto publicado ficticio con fecha conservada.</p>',
        status: 'published', published_at: sourceDate });
      const sourceBefore = (await db.ConsentTemplateCatalogVersion.findByPk(8501)).toJSON();
      const copiedPublished = await consents.propagateAdminTemplateToClinics(850, { clinic_ids: [100], userId: 7 });
      assert.equal(copiedPublished.created_count, 1);
      const publishedTemplate = await db.ClinicConsentTemplate.findOne({ where: { source_catalog_id: 850, clinic_id: 100 } });
      const publishedCopy = await db.ClinicConsentTemplateVersion.findOne({ where: { clinic_template_id: publishedTemplate.id } });
      assert.equal(publishedCopy.status, 'published'); assert.equal(publishedCopy.locale, 'es');
      assert.equal(Number(publishedCopy.source_catalog_version_id), 8501);
      assert.equal(+publishedCopy.published_at, +sourceDate); assert.equal(publishedCopy.body_html, sourceBefore.body_html);
      await db.Tratamiento.create({ id_tratamiento: 210, clinica_id: 100, nombre: 'Técnica ficticia publicada',
        disciplina: 'Ficticia', origen: 'clinica', eliminado_por_clinica: [], activo: true, precio_base: 10 });
      await db.TreatmentConsentRequirement.create({ tratamiento_id: 210, clinica_id: 100,
        clinic_template_id: publishedTemplate.id, required: true, blocking_policy: 'hard' });
      const issued = await f.prepare(210);
      await consents.signConsentDocument(issued.doc.id, f.signature('published-copy'));
      const frozen = (await db.PatientConsentDocument.findByPk(issued.doc.id)).toJSON();
      await db.ConsentTemplateCatalogVersion.create({ id: 8502, catalog_id: 850, version: 2, locale: 'es',
        title: 'Borrador posterior ficticio', body_html: '<p>Texto borrador posterior que no sustituye la copia.</p>',
        status: 'draft', published_at: null });
      const repeated = await consents.propagateAdminTemplateToClinics(850, { clinic_ids: [100], userId: 7 });
      assert.equal(repeated.created_count, 0); assert.equal(repeated.skipped[0].reason, 'already_exists');
      const unchangedCopy = await db.ClinicConsentTemplateVersion.findByPk(publishedCopy.id);
      assert.deepEqual(unchangedCopy.toJSON(), publishedCopy.toJSON());
      await consents.createPackageForAppointment(issued.cita.id_cita);
      const retained = (await db.PatientConsentDocument.findByPk(issued.doc.id)).toJSON();
      assert.equal(retained.snapshot_hash, frozen.snapshot_hash); assert.deepEqual(retained.snapshot_json, frozen.snapshot_json);
      assert.equal(retained.status, 'signed');
      await f.arrive(issued.cita); await f.start(issued.cita);
      assert.deepEqual((await db.ConsentTemplateCatalogVersion.findByPk(8501)).toJSON(), sourceBefore);
      observations.push({ scenario: 'published_copy_exact_date_and_historical_signed_snapshot_preserved', passed: true,
        source_publication_date: sourceDate.toISOString(), medical_approval_inferred: false });

      // Existing input formats/defaults are verified through actual creation
      // and native DATE persistence; a draft never acquires a publication date.
      const formats = [
        { key: 'published_default', payload: {}, state: 'published' },
        { key: 'published_ISO', payload: { version_status: 'published', published_at: sourceDate.toISOString() }, state: 'published', date: sourceDate },
        { key: 'published_Date', payload: { version_status: 'published', published_at: sourceDate }, state: 'published', date: sourceDate },
        { key: 'published_explicit_null', payload: { version_status: 'published', published_at: null }, state: 'published', date: null },
        { key: 'draft_explicit_null', payload: { version_status: 'draft', published_at: null }, state: 'draft', date: null },
        { key: 'draft_with_client_date', payload: { version_status: 'draft', published_at: sourceDate.toISOString() }, state: 'draft', date: null },
        { key: 'archived_existing_date', payload: { version_status: 'archived', published_at: sourceDate }, state: 'archived', date: sourceDate },
      ];
      for (const format of formats) {
        const before = Date.now();
        const template = await consents.createClinicTemplate({ clinic_id: 100, name: 'Formato ficticio ' + format.key,
          purpose: 'clinical', status: 'active', locale: 'ca', body_html: '<p>Contenido ficticio de formato.</p>', ...format.payload }, 7);
        const persisted = await db.ClinicConsentTemplateVersion.findOne({ where: { clinic_template_id: template.id } });
        assert.equal(persisted.status, format.state); assert.equal(persisted.locale, 'ca');
        if (Object.hasOwn(format, 'date')) assert.equal(persisted.published_at === null ? null : +persisted.published_at,
          format.date === null ? null : +format.date);
        else assert(+persisted.published_at >= before - 1000 && +persisted.published_at <= Date.now());
        observations.push({ scenario: format.key, passed: true, state: persisted.status, locale: persisted.locale,
          published_at: persisted.published_at });
      }
      context.report.boundaries = { real_services_and_native_sql: true, employee_http_auth_e2e: false,
        production_data_touched: false, external_sends: 0, clinical_approval_created: false, source_rows_edited: false };
      context.report.checks.push('Actual sync and propagation copy exact source text/ID/locale without promoting draft publication; active copied template with draft-only version cannot issue a patient document');
      assert.deepEqual(violations, [], 'Unsafe catalog copy publication reproduced: ' + JSON.stringify(observations));
    });
  });
