'use strict';

const { templates, variableSchema } = require('../src/scripts/data/bsmedical-consentimientos-library');

const TARGET_CLINIC_NAMES = ['bs medical', 'bs medical · demo'];

function normalizeBody(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function normalizeJson(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch (_error) {
      return value.trim();
    }
  }
  return JSON.stringify(value);
}

function templateVariableSchema(item) {
  return {
    ...variableSchema,
    signing_timing: {
      mode: item.signing_timing || 'before_treatment',
      recommended_min_hours_before: item.signing_timing === 'at_least_24h_before' ? 24 : null,
    },
    clinical_policy: {
      signing_timing: item.signing_timing || 'before_treatment',
      requires_explanation_statement: item.requires_professional_signature === true,
    },
    source: {
      type: 'bsmedical_pdf_library',
      source_zip: 'frontend_clinicaclick/temp/consentimientos.zip',
      source_file: item.file,
      imported_at: '2026-08-31',
      privacy: 'pdf_text_sanitized_before_commit',
      cleanup: 'pdf_line_breaks_removed_and_labels_normalized',
    },
  };
}

async function findTargetClinics(queryInterface, Sequelize) {
  return queryInterface.sequelize.query(
    `SELECT id_clinica
       FROM Clinicas
      WHERE LOWER(nombre_clinica) IN (:names)`,
    {
      replacements: { names: TARGET_CLINIC_NAMES },
      type: Sequelize.QueryTypes.SELECT,
    }
  );
}

async function getCatalog(queryInterface, Sequelize, catalogKey) {
  const rows = await queryInterface.sequelize.query(
    `SELECT id
       FROM ConsentTemplateCatalogs
      WHERE catalog_key = :catalogKey
      LIMIT 1`,
    {
      replacements: { catalogKey },
      type: Sequelize.QueryTypes.SELECT,
    }
  );
  return rows[0] || null;
}

async function getLatestVersion(queryInterface, Sequelize, table, foreignKey, ownerId) {
  const rows = await queryInterface.sequelize.query(
    `SELECT id, version, title, body_html, variable_schema
       FROM ${table}
      WHERE ${foreignKey} = :ownerId AND locale = 'es'
      ORDER BY version DESC, id DESC
      LIMIT 1`,
    {
      replacements: { ownerId },
      type: Sequelize.QueryTypes.SELECT,
    }
  );
  return rows[0] || null;
}

async function upsertLatestVersion(queryInterface, Sequelize, {
  table,
  foreignKey,
  ownerId,
  item,
  now,
  sourceCatalogVersionId = null,
}) {
  const latest = await getLatestVersion(queryInterface, Sequelize, table, foreignKey, ownerId);
  const nextSchema = JSON.stringify(templateVariableSchema(item));
  const next = {
    title: item.title || item.name,
    body_json: null,
    body_html: item.body_html,
    variable_schema: nextSchema,
    status: 'published',
    published_at: now,
    created_by: 1,
    updatedAt: now,
  };
  if (table === 'ClinicConsentTemplateVersions') {
    next.source_catalog_version_id = sourceCatalogVersionId;
  }

  const changed = !latest
    || normalizeBody(latest.title) !== normalizeBody(next.title)
    || normalizeBody(latest.body_html) !== normalizeBody(next.body_html)
    || normalizeJson(latest.variable_schema) !== normalizeJson(next.variable_schema);

  if (changed) {
    await queryInterface.bulkInsert(table, [{
      ...next,
      [foreignKey]: ownerId,
      version: latest ? Number(latest.version || 0) + 1 : 1,
      locale: 'es',
      createdAt: now,
    }]);
  } else {
    await queryInterface.bulkUpdate(table, next, { id: latest.id });
  }

  const current = await getLatestVersion(queryInterface, Sequelize, table, foreignKey, ownerId);
  return current?.id || null;
}

async function getClinicTemplates(queryInterface, Sequelize, clinicIds, catalogId, catalogKey) {
  if (!clinicIds.length) return [];
  return queryInterface.sequelize.query(
    `SELECT id
       FROM ClinicConsentTemplates
      WHERE clinic_id IN (:clinicIds)
        AND (source_catalog_id = :catalogId OR catalog_key = :catalogKey)`,
    {
      replacements: { clinicIds, catalogId, catalogKey },
      type: Sequelize.QueryTypes.SELECT,
    }
  );
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const now = new Date();
    const clinics = await findTargetClinics(queryInterface, Sequelize);
    const clinicIds = clinics.map((clinic) => clinic.id_clinica).filter(Boolean);

    for (const item of templates) {
      const catalog = await getCatalog(queryInterface, Sequelize, item.catalog_key);
      if (!catalog?.id) continue;

      await queryInterface.bulkUpdate('ConsentTemplateCatalogs', {
        name: item.name,
        description: item.description,
        purpose: item.purpose,
        blocking_policy: item.blocking_policy,
        validity_mode: item.validity_mode,
        is_generic: !!item.is_generic,
        requires_professional_signature: !!item.requires_professional_signature,
        updatedAt: now,
      }, { id: catalog.id });

      const catalogVersionId = await upsertLatestVersion(queryInterface, Sequelize, {
        table: 'ConsentTemplateCatalogVersions',
        foreignKey: 'catalog_id',
        ownerId: catalog.id,
        item,
        now,
      });

      const clinicTemplates = await getClinicTemplates(queryInterface, Sequelize, clinicIds, catalog.id, item.catalog_key);
      for (const clinicTemplate of clinicTemplates) {
        await queryInterface.bulkUpdate('ClinicConsentTemplates', {
          source_catalog_id: catalog.id,
          source_catalog_version_id: catalogVersionId,
          name: item.name,
          description: item.description,
          purpose: item.purpose,
          blocking_policy: item.blocking_policy,
          validity_mode: item.validity_mode,
          is_default: true,
          requires_professional_signature: !!item.requires_professional_signature,
          updatedAt: now,
        }, { id: clinicTemplate.id });

        await upsertLatestVersion(queryInterface, Sequelize, {
          table: 'ClinicConsentTemplateVersions',
          foreignKey: 'clinic_template_id',
          ownerId: clinicTemplate.id,
          item,
          now,
          sourceCatalogVersionId: catalogVersionId,
        });
      }
    }
  },

  async down() {
    // No borra ni archiva versiones: pueden estar referenciadas por paquetes
    // o documentos ya firmados. La retirada debe ser explicita y auditable.
  },
};
