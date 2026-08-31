'use strict';

const crypto = require('crypto');
const { templates, variableSchema } = require('../src/scripts/data/bsmedical-consentimientos-library');

const TARGET_CLINIC_NAMES = ['bs medical', 'bs medical · demo'];

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
    },
  };
}

async function findByCatalogKey(queryInterface, Sequelize, table, catalogKey) {
  const rows = await queryInterface.sequelize.query(
    `SELECT id FROM ${table} WHERE catalog_key = :catalogKey LIMIT 1`,
    {
      replacements: { catalogKey },
      type: Sequelize.QueryTypes.SELECT,
    }
  );
  return rows[0]?.id || null;
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

async function upsertVersion(queryInterface, Sequelize, {
  table,
  foreignKey,
  ownerId,
  item,
  sourceCatalogVersionId,
  now,
}) {
  const latest = await getLatestVersion(queryInterface, Sequelize, table, foreignKey, ownerId);
  const versionRow = {
    title: item.title || item.name,
    body_json: null,
    body_html: item.body_html,
    variable_schema: JSON.stringify(templateVariableSchema(item)),
    status: 'published',
    published_at: now,
    created_by: 1,
    updatedAt: now,
  };
  if (table === 'ClinicConsentTemplateVersions') {
    versionRow.source_catalog_version_id = sourceCatalogVersionId || null;
  }

  const changed = !latest
    || normalizeBody(latest.title) !== normalizeBody(versionRow.title)
    || normalizeBody(latest.body_html) !== normalizeBody(versionRow.body_html)
    || normalizeJson(latest.variable_schema) !== normalizeJson(versionRow.variable_schema);

  if (!latest || changed) {
    await queryInterface.bulkInsert(table, [{
      ...versionRow,
      [foreignKey]: ownerId,
      version: latest ? Number(latest.version || 0) + 1 : 1,
      locale: 'es',
      createdAt: now,
    }]);
  } else {
    await queryInterface.bulkUpdate(table, versionRow, { id: latest.id });
  }

  const current = await getLatestVersion(queryInterface, Sequelize, table, foreignKey, ownerId);
  return current?.id || null;
}

async function syncCatalogDisciplines(queryInterface, catalogId, item, now) {
  await queryInterface.bulkDelete('ConsentTemplateCatalogDisciplines', { catalog_id: catalogId });
  if (!Array.isArray(item.disciplines) || !item.disciplines.length) return;
  await queryInterface.bulkInsert('ConsentTemplateCatalogDisciplines', item.disciplines.map((disciplinaCode) => ({
    catalog_id: catalogId,
    disciplina_code: disciplinaCode,
    createdAt: now,
    updatedAt: now,
  })));
}

async function upsertCatalogTemplate(queryInterface, Sequelize, item, now) {
  let catalogId = await findByCatalogKey(queryInterface, Sequelize, 'ConsentTemplateCatalogs', item.catalog_key);
  const row = {
    catalog_key: item.catalog_key,
    name: item.name,
    description: item.description,
    purpose: item.purpose,
    status: 'active',
    blocking_policy: item.blocking_policy,
    validity_mode: item.validity_mode,
    is_generic: !!item.is_generic,
    requires_patient_signature: true,
    requires_representative_when_minor: true,
    requires_professional_signature: !!item.requires_professional_signature,
    created_by: 1,
    updatedAt: now,
  };

  if (catalogId) {
    await queryInterface.bulkUpdate('ConsentTemplateCatalogs', row, { id: catalogId });
  } else {
    await queryInterface.bulkInsert('ConsentTemplateCatalogs', [{
      ...row,
      public_id: deterministicPublicId('cadmin', item.catalog_key),
      createdAt: now,
    }]);
    catalogId = await findByCatalogKey(queryInterface, Sequelize, 'ConsentTemplateCatalogs', item.catalog_key);
  }
  if (!catalogId) return null;

  await syncCatalogDisciplines(queryInterface, catalogId, item, now);
  const versionId = await upsertVersion(queryInterface, Sequelize, {
    table: 'ConsentTemplateCatalogVersions',
    foreignKey: 'catalog_id',
    ownerId: catalogId,
    item,
    now,
  });

  return { catalogId, catalogVersionId: versionId };
}

async function findTargetClinics(queryInterface, Sequelize) {
  return queryInterface.sequelize.query(
    `SELECT id_clinica, nombre_clinica
       FROM Clinicas
      WHERE LOWER(nombre_clinica) IN (:names)
      ORDER BY id_clinica`,
    {
      replacements: { names: TARGET_CLINIC_NAMES },
      type: Sequelize.QueryTypes.SELECT,
    }
  );
}

async function findClinicTemplate(queryInterface, Sequelize, clinicId, item, catalogId) {
  const rows = await queryInterface.sequelize.query(
    `SELECT id
       FROM ClinicConsentTemplates
      WHERE clinic_id = :clinicId
        AND (catalog_key = :catalogKey OR source_catalog_id = :catalogId)
      ORDER BY id ASC
      LIMIT 1`,
    {
      replacements: {
        clinicId,
        catalogKey: item.catalog_key,
        catalogId,
      },
      type: Sequelize.QueryTypes.SELECT,
    }
  );
  return rows[0]?.id || null;
}

async function upsertClinicTemplate(queryInterface, Sequelize, clinic, item, catalogInfo, now) {
  let templateId = await findClinicTemplate(queryInterface, Sequelize, clinic.id_clinica, item, catalogInfo.catalogId);
  const row = {
    clinic_id: clinic.id_clinica,
    source_catalog_id: catalogInfo.catalogId,
    source_catalog_version_id: catalogInfo.catalogVersionId,
    catalog_key: item.catalog_key,
    name: item.name,
    description: item.description,
    purpose: item.purpose,
    status: 'active',
    blocking_policy: item.blocking_policy,
    validity_mode: item.validity_mode,
    is_default: true,
    requires_patient_signature: true,
    requires_representative_when_minor: true,
    requires_professional_signature: !!item.requires_professional_signature,
    created_by: 1,
    updatedAt: now,
  };

  if (templateId) {
    await queryInterface.bulkUpdate('ClinicConsentTemplates', row, { id: templateId });
  } else {
    await queryInterface.bulkInsert('ClinicConsentTemplates', [{
      ...row,
      public_id: deterministicPublicId('cclin', clinic.id_clinica, item.catalog_key),
      createdAt: now,
    }]);
    templateId = await findClinicTemplate(queryInterface, Sequelize, clinic.id_clinica, item, catalogInfo.catalogId);
  }
  if (!templateId) return null;

  await upsertVersion(queryInterface, Sequelize, {
    table: 'ClinicConsentTemplateVersions',
    foreignKey: 'clinic_template_id',
    ownerId: templateId,
    item,
    sourceCatalogVersionId: catalogInfo.catalogVersionId,
    now,
  });

  return templateId;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const now = new Date();
    const clinics = await findTargetClinics(queryInterface, Sequelize);
    const catalogByKey = new Map();

    for (const item of templates) {
      const catalogInfo = await upsertCatalogTemplate(queryInterface, Sequelize, item, now);
      if (catalogInfo) catalogByKey.set(item.catalog_key, catalogInfo);
    }

    for (const clinic of clinics) {
      for (const item of templates) {
        const catalogInfo = catalogByKey.get(item.catalog_key);
        if (!catalogInfo) continue;
        await upsertClinicTemplate(queryInterface, Sequelize, clinic, item, catalogInfo, now);
      }
    }
  },

  async down() {
    // Deliberadamente no borra ni archiva plantillas: pueden estar referenciadas
    // por documentos firmados o paquetes emitidos. Una retirada debe hacerse con
    // una migracion explicita de archivado y revision de referencias.
  },
};
