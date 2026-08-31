'use strict';

const crypto = require('crypto');

const TARGET_CLINIC_NAMES = ['bs medical', 'bs medical · demo'];
const PORTAL_CATALOG_KEY = 'cc_base_portal_paciente_usuario_gratuito_v1';

function deterministicPublicId(prefix, ...parts) {
  const hash = crypto.createHash('sha1').update(parts.join(':')).digest('hex').slice(0, 24);
  return `${prefix}_${hash}`;
}

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

async function getLatestCatalogVersion(queryInterface, Sequelize, catalogId) {
  const rows = await queryInterface.sequelize.query(
    `SELECT id, version, title, body_html, variable_schema
       FROM ConsentTemplateCatalogVersions
      WHERE catalog_id = :catalogId AND locale = 'es'
      ORDER BY version DESC, id DESC
      LIMIT 1`,
    {
      replacements: { catalogId },
      type: Sequelize.QueryTypes.SELECT,
    }
  );
  return rows[0] || null;
}

async function getLatestClinicVersion(queryInterface, Sequelize, templateId) {
  const rows = await queryInterface.sequelize.query(
    `SELECT id, version, title, body_html, variable_schema, source_catalog_version_id
       FROM ClinicConsentTemplateVersions
      WHERE clinic_template_id = :templateId AND locale = 'es'
      ORDER BY version DESC, id DESC
      LIMIT 1`,
    {
      replacements: { templateId },
      type: Sequelize.QueryTypes.SELECT,
    }
  );
  return rows[0] || null;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const now = new Date();
    const catalogs = await queryInterface.sequelize.query(
      'SELECT * FROM ConsentTemplateCatalogs WHERE catalog_key = :catalogKey LIMIT 1',
      {
        replacements: { catalogKey: PORTAL_CATALOG_KEY },
        type: Sequelize.QueryTypes.SELECT,
      }
    );
    const catalog = catalogs[0] || null;
    if (!catalog) return;

    const catalogVersion = await getLatestCatalogVersion(queryInterface, Sequelize, catalog.id);
    if (!catalogVersion) return;

    const clinics = await queryInterface.sequelize.query(
      `SELECT id_clinica, nombre_clinica
         FROM Clinicas
        WHERE LOWER(nombre_clinica) IN (:names)
        ORDER BY id_clinica`,
      {
        replacements: { names: TARGET_CLINIC_NAMES },
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    for (const clinic of clinics) {
      const existingRows = await queryInterface.sequelize.query(
        `SELECT id
           FROM ClinicConsentTemplates
          WHERE clinic_id = :clinicId
            AND (catalog_key = :catalogKey OR source_catalog_id = :catalogId)
          ORDER BY id ASC
          LIMIT 1`,
        {
          replacements: {
            clinicId: clinic.id_clinica,
            catalogKey: PORTAL_CATALOG_KEY,
            catalogId: catalog.id,
          },
          type: Sequelize.QueryTypes.SELECT,
        }
      );
      let templateId = existingRows[0]?.id || null;
      const row = {
        clinic_id: clinic.id_clinica,
        source_catalog_id: catalog.id,
        source_catalog_version_id: catalogVersion.id,
        catalog_key: catalog.catalog_key,
        name: catalog.name,
        description: catalog.description,
        purpose: catalog.purpose,
        status: 'active',
        blocking_policy: catalog.blocking_policy,
        validity_mode: catalog.validity_mode,
        is_default: true,
        requires_patient_signature: catalog.requires_patient_signature !== false,
        requires_representative_when_minor: catalog.requires_representative_when_minor !== false,
        requires_professional_signature: !!catalog.requires_professional_signature,
        created_by: 1,
        updatedAt: now,
      };

      if (templateId) {
        await queryInterface.bulkUpdate('ClinicConsentTemplates', row, { id: templateId });
      } else {
        await queryInterface.bulkInsert('ClinicConsentTemplates', [{
          ...row,
          public_id: deterministicPublicId('cclin', clinic.id_clinica, PORTAL_CATALOG_KEY),
          createdAt: now,
        }]);
        const createdRows = await queryInterface.sequelize.query(
          `SELECT id
             FROM ClinicConsentTemplates
            WHERE clinic_id = :clinicId AND catalog_key = :catalogKey
            ORDER BY id DESC
            LIMIT 1`,
          {
            replacements: { clinicId: clinic.id_clinica, catalogKey: PORTAL_CATALOG_KEY },
            type: Sequelize.QueryTypes.SELECT,
          }
        );
        templateId = createdRows[0]?.id || null;
      }
      if (!templateId) continue;

      const latest = await getLatestClinicVersion(queryInterface, Sequelize, templateId);
      const versionRow = {
        clinic_template_id: templateId,
        source_catalog_version_id: catalogVersion.id,
        version: latest ? Number(latest.version || 0) + 1 : 1,
        locale: 'es',
        title: catalogVersion.title || catalog.name,
        body_json: null,
        body_html: catalogVersion.body_html,
        variable_schema: normalizeJson(catalogVersion.variable_schema) || null,
        status: 'published',
        published_at: now,
        created_by: 1,
        createdAt: now,
        updatedAt: now,
      };
      const changed = !latest
        || Number(latest.source_catalog_version_id || 0) !== Number(catalogVersion.id)
        || normalizeBody(latest.title) !== normalizeBody(versionRow.title)
        || normalizeBody(latest.body_html) !== normalizeBody(versionRow.body_html)
        || normalizeJson(latest.variable_schema) !== normalizeJson(versionRow.variable_schema);

      if (changed) {
        await queryInterface.bulkInsert('ClinicConsentTemplateVersions', [versionRow]);
      } else {
        await queryInterface.bulkUpdate('ClinicConsentTemplateVersions', {
          source_catalog_version_id: catalogVersion.id,
          status: 'published',
          updatedAt: now,
        }, { id: latest.id });
      }
    }
  },

  async down() {
    // No se retira automaticamente: puede estar referenciada por paquetes o documentos.
  },
};
